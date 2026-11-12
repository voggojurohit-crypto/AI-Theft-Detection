# Sentinel AI — Dual-Mode Smart Anti-Theft & Home Security System

A local-first prototype for a **retail store/supermarket** and **home residence** using a laptop webcam. It retains the project's core stack: Python, YOLOv8, ByteTrack, MediaPipe, OpenCV, Flask, React, TypeScript and SQLite.

> **Safety and accuracy:** This application raises review alerts, not conclusions. A person entering a zone, carrying an object, or appearing on camera is not proof of theft or trespass. False alerts are expected. A human must review the original footage and context. Do not use this system for automatic accusations, detention, or emergency response.

## Two monitoring profiles

### 1. Retail store / supermarket
- Detects people and common portable COCO objects with YOLOv8.
- Uses ByteTrack IDs to follow detections across frames.
- Allows checkout and exit zones to be configured for the camera view.
- Creates a **potential exit-with-item review alert** when a tracked person is associated with a portable object in the exit zone without a checkout-zone visit in that track.
- This is only a rough heuristic; it is not a substitute for POS/payment integration, item-level tracking, or staff review.

### 2. Home residence
- Uses the same webcam, YOLOv8, ByteTrack, OpenCV, Flask and dashboard.
- Configure a **restricted area** (for example, a doorway, private room, or area that should be empty while away).
- Turn on **Arm home monitoring** before starting the camera.
- While armed, a person detection whose foot point enters the configured restricted zone creates a **potential restricted-zone entry review alert**.
- Disarm before household members or visitors enter. This simple mode does not identify familiar people and may alert on residents, visitors, reflections, pets, or false detections.

## Laptop webcam setup (Windows 11)

1. Install Python 3.11 and Node.js 18+ (LTS recommended).
2. Extract this project to a simple path such as `C:\Projects\Smart-Anti-Theft-System`.
3. Double-click `setup-windows.bat`.
4. Double-click `start-all.bat`.
5. Open `http://127.0.0.1:5173`.
6. Select **Retail store / supermarket** or **Home residence security**.
7. Set camera source to `0` for the laptop's default webcam. If that does not work, try `1`.
8. Click **Start monitoring**. For home mode, first calibrate the restricted area, then tick **Arm home monitoring** only when that area should be empty.
9. If you move or tilt the laptop webcam, use the dashboard's **Camera positioning & zone calibration** controls to redraw the zones for the new view.

The first model load may download `yolov8n.pt`; internet access is required once. The laptop must remain awake and the browser/backend must remain running.

## Install and run manually

From the project root in PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r ai_backend\requirements.txt
cd frontend
npm install
npm run dev
```

In a second PowerShell window, from the project root:

```powershell
.\.venv\Scripts\Activate.ps1
python ai_backend\app.py
```

Dashboard: `http://127.0.0.1:5173` · API: `http://127.0.0.1:5000/api/health`

## Movable laptop webcam and live zone calibration

The laptop webcam is treated as a manually repositionable camera. It is not a motorized pan/tilt camera: physically move the laptop or its screen, then recalibrate the image zones because the scene coordinates have changed.

1. Start monitoring and wait for the live camera image.
2. In **Retail store / supermarket** mode, choose **Checkout zone** or **Exit zone**. In **Home residence security** mode, choose **Restricted area**.
3. Click at least three points around the area in the live image. The points form a polygon; use **Undo point** or **Clear points** if needed.
4. Select **Save zone**. The polygon is stored in `config.json` and is used immediately by the detector.
5. Repeat after moving or tilting the webcam. Keep the laptop stable after calibration.

Zones use normalized coordinates from 0 to 1: `[0,0]` is top-left and `[1,1]` is bottom-right. The dashboard calibration tool is preferred to editing `config.json` manually.

- Retail: outline the actual payment/checkout area and the exit passage. The exit zone should cover the area where a person is expected to leave the store.
- Home: outline only the doorway, room, or area that should trigger a review alert. The default polygon covers most of the image and is only a placeholder; calibrate it before arming.

A laptop webcam is a demonstration input. Its field of view and position cannot reliably cover an entire shop or house. Mount the laptop safely, ensure adequate lighting, avoid private spaces, and test the exact camera angle. For real deployment, use suitable fixed cameras and privacy safeguards.

## Technology stack

| Layer | Technology | Role |
|---|---|---|
| Detection | YOLOv8 / Ultralytics | Person and common object detection |
| Tracking | ByteTrack | Persistent object/person track IDs |
| Pose context | MediaPipe | Optional pose landmark visualization |
| Video | OpenCV | Webcam/video capture and annotation |
| Backend | Python + Flask | Camera processing and REST APIs |
| Frontend | React + TypeScript | Live monitoring and event review |
| Storage | SQLite | Event metadata and review status |

## API endpoints

- `GET /api/health` — dependency and current profile status
- `GET /api/status` — camera/processing state
- `POST /api/camera/start` — JSON: `{"source":0,"profile":"retail","armed":false}` (home profile uses `"profile":"home","armed":true`)
- `POST /api/camera/stop` — stop monitoring
- `GET /api/video_feed` — annotated MJPEG feed
- `POST /api/upload` — upload a video for analysis (uses the currently selected profile)
- `GET /api/events` — event history
- `PATCH /api/events/<id>` — review status
- `GET /api/evidence/<filename>` — evidence image
- `GET /api/config`, `PUT /api/config` — read/update settings, mode, arming state and zones

## Current limitations / next steps

1. **No theft recognition model:** COCO YOLOv8 classes are generic; they do not detect the act of stealing, concealment, payment status, or ownership.
2. **Retail needs transaction context:** integrate POS/payment events and product-level shelf/checkout tracking before claiming useful theft detection.
3. **Home mode is zone intrusion only:** it does not recognize authorized residents or distinguish an invited guest from an intruder. Consider a user-controlled schedule and a separate allow/deny workflow, but do not infer identity from appearance.
4. **Tracking can fail:** ByteTrack IDs may switch after occlusion, low light, or people crossing.
5. **MediaPipe is optional context:** pose landmarks are not evidence of wrongdoing.
6. **Local storage:** secure the laptop, restrict access to evidence, set a short retention period, and delete footage that is no longer needed.
7. **Privacy:** inform household members, visitors, employees and customers as appropriate; avoid private spaces; comply with applicable local law. Do not upload footage to third parties without a clear lawful basis and consent where required.

## Project structure

```text
Smart-Anti-Theft-System/
├── ai_backend/app.py
├── ai_backend/requirements.txt
├── frontend/src/App.tsx
├── frontend/src/style.css
├── frontend/package.json
├── config.json
├── setup-windows.bat
└── start-all.bat
```
