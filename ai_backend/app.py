"""AI-assisted retail loss-prevention prototype.

Alerts are review prompts, not determinations that a person committed theft.
"""
from __future__ import annotations
import os, cv2, json, time, uuid, threading, sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename

try:
    from ultralytics import YOLO
except Exception as exc:
    YOLO = None
    YOLO_IMPORT_ERROR = str(exc)
else:
    YOLO_IMPORT_ERROR = None

try:
    import mediapipe as mp
except Exception:
    mp = None

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UPLOADS = DATA / "uploads"
EVIDENCE = DATA / "evidence"
DB_PATH = DATA / "anti_theft.db"
CONFIG_PATH = ROOT / "config.json"
for p in (DATA, UPLOADS, EVIDENCE): p.mkdir(parents=True, exist_ok=True)

DEFAULT_CONFIG = {
    "model": "yolov8n.pt",
    "confidence": 0.35,
    "camera_index": 0,
    "profile": "retail",
    "armed": False,
    "frame_width": 960,
    "portable_classes": ["backpack", "handbag", "suitcase", "cell phone", "laptop", "book", "bottle", "cup"],
    "zones": {
        "checkout": [[0.35, 0.55], [0.70, 0.55], [0.70, 0.98], [0.35, 0.98]],
        "exit": [[0.82, 0.10], [0.99, 0.10], [0.99, 0.98], [0.82, 0.98]],
        "restricted": [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]]
    },
    "alert_cooldown_seconds": 20,
    "association_distance_ratio": 0.75
}

def load_config():
    if CONFIG_PATH.exists():
        try:
            current = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            merged = {**DEFAULT_CONFIG, **current}
            merged["zones"] = {**DEFAULT_CONFIG["zones"], **current.get("zones", {})}
            return merged
        except Exception:
            pass
    CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")
    return DEFAULT_CONFIG.copy()

config = load_config()
app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024

state = {"running": False, "source": None, "message": "Ready", "last_frame": None, "fps": 0.0, "processed": 0}
state_lock = threading.RLock()
model_lock = threading.RLock()
model = None
camera_thread: Optional[threading.Thread] = None
stop_event = threading.Event()
last_alert_by_track = {}
track_checkout_seen = set()
pose_estimator = None


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()

def init_db():
    with db() as con:
        con.execute("""CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE, created_at TEXT NOT NULL,
            event_type TEXT NOT NULL, severity TEXT NOT NULL, person_track_id INTEGER,
            object_label TEXT, object_track_id INTEGER, confidence REAL, status TEXT DEFAULT 'Needs review',
            source TEXT, evidence_path TEXT, notes TEXT)""")
        con.execute("CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)")
init_db()


def get_model():
    global model
    if YOLO is None:
        raise RuntimeError("Ultralytics is not installed. Run: pip install -r ai_backend/requirements.txt. " + str(YOLO_IMPORT_ERROR))
    with model_lock:
        if model is None:
            model = YOLO(config.get("model", "yolov8n.pt"))
        return model


def get_pose():
    global pose_estimator
    if mp is None:
        return None
    if pose_estimator is None:
        try:
            pose_estimator = mp.solutions.pose.Pose(static_image_mode=False, model_complexity=0,
                enable_segmentation=False, min_detection_confidence=0.45, min_tracking_confidence=0.45)
        except Exception:
            return None
    return pose_estimator


def point_in_zone(point, polygon):
    if not polygon: return False
    poly = np.array([[int(x * 10000), int(y * 10000)] for x, y in polygon], dtype=np.int32)
    return cv2.pointPolygonTest(poly, (int(point[0] * 10000), int(point[1] * 10000)), False) >= 0


def center(box):
    x1, y1, x2, y2 = box
    return ((x1+x2)/2, (y1+y2)/2)


def save_event(frame, person_id, obj_id, label, conf, source, reason, event_type="EXIT_WITH_ITEM_REVIEW"):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    event_key = f"{source}:{person_id}:{obj_id}:{int(time.time() // max(1, int(config.get('alert_cooldown_seconds',20))))}"
    filename = f"event_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.jpg"
    path = EVIDENCE / filename
    cv2.imwrite(str(path), frame)
    with db() as con:
        con.execute("""INSERT OR IGNORE INTO events(event_key,created_at,event_type,severity,person_track_id,
          object_label,object_track_id,confidence,status,source,evidence_path,notes)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
          (event_key, now, event_type, "Review", person_id, label, obj_id,
           float(conf), "Needs review", source, str(path.relative_to(ROOT)), reason))


def analyse_frame(frame, source="camera", tracker=True):
    """Detect and track people/items, draw overlays, and raise conservative review events.

    The prototype flags a tracked person in the configured exit zone while a portable
    object is spatially associated with them and the person has not visited checkout.
    This heuristic needs site-specific calibration and human review.
    """
    h, w = frame.shape[:2]
    if w > int(config.get("frame_width", 960)):
        nh = int(h * int(config["frame_width"]) / w)
        frame = cv2.resize(frame, (int(config["frame_width"]), nh))
        h, w = frame.shape[:2]
    annotated = frame.copy()
    yolo = get_model()
    results = yolo.track(frame, persist=tracker, tracker="bytetrack.yaml", conf=float(config.get("confidence", .35)),
                         verbose=False, imgsz=640) if tracker else yolo(frame, conf=float(config.get("confidence", .35)), verbose=False)
    people, items = [], []
    names = yolo.names
    for result in results:
        boxes = result.boxes
        if boxes is None: continue
        for b in boxes:
            cls_id = int(b.cls[0].item())
            label = str(names.get(cls_id, cls_id))
            conf = float(b.conf[0].item())
            xyxy = [int(v) for v in b.xyxy[0].tolist()]
            tid = int(b.id[0].item()) if b.id is not None else -1
            row = {"box": xyxy, "id": tid, "label": label, "conf": conf}
            if label == "person": people.append(row)
            elif label in config.get("portable_classes", DEFAULT_CONFIG["portable_classes"]): items.append(row)

    # Pose estimation provides optional skeleton context on the primary visible person.
    pose = get_pose()
    if pose and people:
        try:
            p = max(people, key=lambda x: (x["box"][2]-x["box"][0])*(x["box"][3]-x["box"][1]))
            x1,y1,x2,y2 = p["box"]
            crop = frame[max(0,y1):min(h,y2), max(0,x1):min(w,x2)]
            if crop.size:
                rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                pose_result = pose.process(rgb)
                if pose_result.pose_landmarks:
                    mp.solutions.drawing_utils.draw_landmarks(annotated[y1:y2, x1:x2], pose_result.pose_landmarks,
                        mp.solutions.pose.POSE_CONNECTIONS)
        except Exception:
            pass

    profile = config.get("profile", "retail")
    checkout_poly = config["zones"].get("checkout", [])
    exit_poly = config["zones"].get("exit", [])
    restricted_poly = config["zones"].get("restricted", [])
    draw_zones = ((restricted_poly, (30, 80, 230), "RESTRICTED AREA"),) if profile == "home" else (
        (checkout_poly, (40, 190, 90), "CHECKOUT"), (exit_poly, (40, 80, 230), "EXIT"))
    for poly, color, label in draw_zones:
        if poly:
            pts = np.array([[int(x*w), int(y*h)] for x,y in poly], np.int32)
            cv2.polylines(annotated,[pts],True,color,2)
            cv2.putText(annotated,label,tuple(pts[0]),cv2.FONT_HERSHEY_SIMPLEX,.55,color,2)

    # Associate each portable object with the nearest person when its center lies
    # near that person's bounding box (expanded by a configurable margin).
    associations = []
    for obj in items:
        ox, oy = center(obj["box"])
        best = None; best_dist = 1e9
        for person in people:
            x1,y1,x2,y2 = person["box"]
            pad = max(x2-x1,y2-y1) * float(config.get("association_distance_ratio",.75))
            expanded = (x1-pad,y1-pad,x2+pad,y2+pad)
            if expanded[0] <= ox <= expanded[2] and expanded[1] <= oy <= expanded[3]:
                px,py = center(person["box"])
                d = ((ox-px)**2+(oy-py)**2)**.5
                if d < best_dist: best, best_dist = person, d
        if best: associations.append((best,obj))

    for person in people:
        x1,y1,x2,y2 = person["box"]
        foot = ((x1+x2)/2, y2)
        norm = (foot[0]/w, foot[1]/h)
        pid = person["id"]
        if point_in_zone(norm, checkout_poly): track_checkout_seen.add(pid)
        if profile == "home" and config.get("armed", False) and point_in_zone(norm, restricted_poly) and pid >= 0:
            cooldown = float(config.get("alert_cooldown_seconds", 20))
            key = ("home", pid)
            if time.time() - last_alert_by_track.get(key, 0) > cooldown:
                save_event(annotated, pid, -1, "person", person["conf"], source,
                           "A person entered the configured restricted zone while home monitoring was armed. Review footage; this is not proof of a break-in.",
                           event_type="RESTRICTED_ZONE_ENTRY_REVIEW")
                last_alert_by_track[key] = time.time()
        color = (50,210,100)
        cv2.rectangle(annotated,(x1,y1),(x2,y2),color,2)
        cv2.putText(annotated,f"Person #{pid}",(x1,max(20,y1-8)),cv2.FONT_HERSHEY_SIMPLEX,.55,color,2)

    for person,obj in associations:
        x1,y1,x2,y2 = obj["box"]
        cv2.rectangle(annotated,(x1,y1),(x2,y2),(0,190,255),2)
        cv2.putText(annotated,f"{obj['label']} #{obj['id']}",(x1,max(20,y1-7)),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,190,255),2)
        px1,py1,px2,py2 = person["box"]
        foot = ((px1+px2)/2, py2)
        at_exit = point_in_zone((foot[0]/w,foot[1]/h), exit_poly)
        checked_out = person["id"] in track_checkout_seen
        if profile == "retail" and at_exit and not checked_out and person["id"] >= 0 and obj["id"] >= 0:
            key = (person["id"], obj["id"])
            cooldown = float(config.get("alert_cooldown_seconds",20))
            if time.time() - last_alert_by_track.get(key,0) > cooldown:
                save_event(annotated, person["id"], obj["id"], obj["label"], obj["conf"], source,
                           "Person/object proximity at exit zone without a recorded checkout-zone visit. Review footage; this is not proof of theft.")
                last_alert_by_track[key] = time.time()

    cv2.putText(annotated,("HOME SECURITY - REVIEW ALERTS ONLY" if profile == "home" else "RETAIL LOSS PREVENTION - REVIEW ALERTS ONLY"),(12,h-14),cv2.FONT_HERSHEY_SIMPLEX,.48,(230,230,230),1)
    with state_lock:
        state["processed"] += 1
    return annotated


def frame_generator():
    while not stop_event.is_set():
        with state_lock:
            frame = None if state["last_frame"] is None else state["last_frame"].copy()
        if frame is None:
            time.sleep(.05); continue
        ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
        if ok:
            yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + encoded.tobytes() + b"\r\n")
        time.sleep(.02)


def camera_loop(source):
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        with state_lock:
            state.update(running=False, message=f"Could not open camera/source: {source}")
        return
    prev = time.time()
    with state_lock: state.update(running=True, message="Camera monitoring active", source=str(source))
    try:
        while not stop_event.is_set():
            ok, frame = cap.read()
            if not ok:
                if isinstance(source, str): break
                time.sleep(.03); continue
            try:
                out = analyse_frame(frame, source="live-camera", tracker=True)
            except Exception as exc:
                with state_lock: state["message"] = f"AI processing error: {exc}"
                out = frame
            now=time.time(); fps=1/max(.001,now-prev); prev=now
            cv2.putText(out,f"FPS: {fps:.1f}",(12,28),cv2.FONT_HERSHEY_SIMPLEX,.7,(255,255,255),2)
            with state_lock:
                state["last_frame"] = out
                state["fps"] = round(fps,1)
    finally:
        cap.release()
        with state_lock: state.update(running=False, message="Monitoring stopped", source=None)


def upload_worker(path):
    cap=cv2.VideoCapture(str(path)); count=0
    try:
        with state_lock: state.update(running=True, source=path.name, message=f"Analysing {path.name}")
        while True:
            ok,frame=cap.read()
            if not ok: break
            try: out=analyse_frame(frame, source=path.name, tracker=True)
            except Exception as exc:
                with state_lock: state["message"] = f"Upload analysis error: {exc}"
                break
            with state_lock: state["last_frame"]=out
            count+=1
        with state_lock: state["message"]=f"Video analysis complete ({count} frames processed)"
    finally:
        cap.release()
        with state_lock: state.update(running=False,source=None)


@app.get("/api/health")
def health():
    return jsonify({"ok":True,"model_loaded":model is not None,"yolo_available":YOLO is not None,
                    "mediapipe_available":mp is not None,"profile":config.get("profile","retail"),"armed":config.get("armed",False),"message":state["message"]})

@app.get("/api/status")
def status():
    with state_lock: return jsonify({k:v for k,v in state.items() if k!="last_frame"})

@app.post("/api/camera/start")
def start_camera():
    global camera_thread
    payload=request.get_json(silent=True) or {}
    if payload.get("profile") in ("retail", "home"):
        config["profile"] = payload["profile"]
    if "armed" in payload:
        config["armed"] = bool(payload["armed"])
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    source=payload.get("source", config.get("camera_index",0))
    if isinstance(source,str) and source.isdigit(): source=int(source)
    if isinstance(source,str) and source.lower() in ("webcam","default"): source=0
    with state_lock:
        if state["running"]: return jsonify({"ok":False,"error":"A source is already being processed"}),409
    stop_event.clear()
    track_checkout_seen.clear(); last_alert_by_track.clear()
    camera_thread=threading.Thread(target=camera_loop,args=(source,),daemon=True)
    camera_thread.start()
    return jsonify({"ok":True,"message":"Camera start requested"})

@app.post("/api/camera/stop")
def stop_camera():
    stop_event.set()
    return jsonify({"ok":True,"message":"Stop requested"})

@app.get("/api/video_feed")
def video_feed():
    return Response(frame_generator(),mimetype="multipart/x-mixed-replace; boundary=frame")

@app.post("/api/upload")
def upload_video():
    if "video" not in request.files: return jsonify({"ok":False,"error":"Choose a video file"}),400
    file=request.files["video"]
    if request.form.get("profile") in ("retail", "home"):
        config["profile"] = request.form.get("profile")
    if "armed" in request.form:
        config["armed"] = request.form.get("armed", "false").lower() == "true"
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    if not file.filename: return jsonify({"ok":False,"error":"No file selected"}),400
    suffix=Path(secure_filename(file.filename)).suffix.lower()
    if suffix not in {".mp4",".avi",".mov",".mkv",".m4v"}: return jsonify({"ok":False,"error":"Supported formats: MP4, AVI, MOV, MKV"}),400
    with state_lock:
        if state["running"]: return jsonify({"ok":False,"error":"Stop current processing before uploading"}),409
    path=UPLOADS/f"{uuid.uuid4().hex}_{secure_filename(file.filename)}"
    file.save(path)
    stop_event.clear()
    track_checkout_seen.clear(); last_alert_by_track.clear()
    threading.Thread(target=upload_worker,args=(path,),daemon=True).start()
    return jsonify({"ok":True,"message":"Video queued for analysis","filename":path.name})

@app.get("/api/events")
def events():
    limit=min(200,max(1,int(request.args.get("limit",100))))
    with db() as con: rows=con.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?",(limit,)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.patch("/api/events/<int:event_id>")
def update_event(event_id):
    payload=request.get_json(silent=True) or {}
    status_value=payload.get("status")
    if status_value not in ("Needs review","Reviewed - no issue","Confirmed incident","False alert"):
        return jsonify({"ok":False,"error":"Invalid review status"}),400
    with db() as con:
        cur=con.execute("UPDATE events SET status=? WHERE id=?",(status_value,event_id))
        if cur.rowcount==0: return jsonify({"ok":False,"error":"Event not found"}),404
    return jsonify({"ok":True})

@app.get("/api/evidence/<path:filename>")
def evidence(filename):
    return send_from_directory(EVIDENCE,filename)

@app.get("/api/config")
def get_config(): return jsonify(config)

@app.put("/api/config")
def update_config():
    global config
    payload=request.get_json(silent=True) or {}
    # Only allow known, bounded settings from the dashboard.
    if "confidence" in payload: config["confidence"]=max(.1,min(.9,float(payload["confidence"])))
    if payload.get("profile") in ("retail", "home"):
        new_profile = payload["profile"]
        if new_profile != config.get("profile"):
            # Track IDs and checkout history are not meaningful across mode changes.
            track_checkout_seen.clear()
            last_alert_by_track.clear()
        config["profile"] = new_profile
    if "armed" in payload: config["armed"] = bool(payload["armed"])
    if "zones" in payload and isinstance(payload["zones"],dict):
        for name in ("checkout","exit","restricted"):
            poly=payload["zones"].get(name)
            if isinstance(poly,list) and len(poly)>=3 and all(isinstance(pt,list) and len(pt)==2 and all(0<=float(v)<=1 for v in pt) for pt in poly):
                config["zones"][name]=poly
    CONFIG_PATH.write_text(json.dumps(config,indent=2),encoding="utf-8")
    return jsonify({"ok":True,"config":config})

if __name__ == "__main__":
    app.run(host="0.0.0.0",port=5000,debug=False,threaded=True)
