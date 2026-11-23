# Sentinel AI — Dual-Mode Smart Anti-Theft & Home Security System

## Live Demo

- **Public Web Application:** https://sentinel-ai-theft-detection-project.onrender.com
- **AI Backend:** Python Flask backend running on the project owner's laptop.
- **Public Backend Access:** Cloudflare Quick Tunnel (temporary HTTPS URL).

### Deployment Architecture

Sentinel AI currently uses a hybrid deployment:

- **Frontend:** Hosted on Render as a static website.
- **Backend:** Python Flask, YOLOv8, ByteTrack and OpenCV running locally on the project owner's Windows laptop.
- **Public connectivity:** Cloudflare Quick Tunnel exposes the local backend through a temporary HTTPS URL.
- **AI processing:** Webcam frames are sent from the public frontend to the laptop backend for inference and annotation.

This is a demonstration deployment, not permanent cloud hosting. The laptop must remain powered on, connected to the internet, and running both Flask and Cloudflare Tunnel.

The Render frontend uses the environment variable `VITE_API_BASE_URL` to connect to the current Cloudflare URL. When a new Quick Tunnel URL is generated, update this variable in Render and redeploy the frontend.

The previous Render-hosted Python backend exceeded its 512 MB memory limit while loading the AI dependencies. The laptop backend is currently used for AI inference instead.

> **Safety and accuracy:** Sentinel AI generates review alerts, not conclusions. Carrying an object or entering a restricted area is not proof of theft or trespass. All alerts require human review.

## Features

### 1. Retail Store / Supermarket
- Person and common portable-object detection using YOLOv8.
- Object tracking using ByteTrack.
- Configurable checkout and exit zones.
- Potential exit-with-item review alerts based on person/object association and configured zones.

### 2. Home Residence Security
- Person detection and tracking.
- Configurable restricted-area monitoring.
- Optional armed monitoring.
- Potential restricted-zone entry review alerts.

The system does not identify familiar people or determine whether someone has permission to enter.

## Technology Stack

| Component | Technology |
|---|---|
| Object Detection | YOLOv8 / Ultralytics |
| Object Tracking | ByteTrack |
| Pose Context | MediaPipe |
| Image Processing | OpenCV |
| Backend | Python, Flask |
| Frontend | React, TypeScript |
| Storage | SQLite |
| Frontend Hosting | Render |
| Public Backend Tunnel | Cloudflare Quick Tunnel |

## Run Locally on Windows

### Requirements
- Windows 10/11
- Python 3.11 recommended
- Node.js 18+ recommended
- Internet access for the initial YOLO model download

### Quick Start
1. Clone or download this repository.
2. Open the project folder in VS Code.
3. Run `setup-windows.bat`.
4. Run `start-all.bat`.
5. Open `http://127.0.0.1:5173`.
6. Select a monitoring profile.
7. Set the browser webcam source to `0`.
8. Click **Start Monitoring** and allow camera access.

The first AI inference may download `yolov8n.pt`.

## Public Online Demonstration Using Cloudflare

The following setup connects the Render frontend to the Flask backend running on the laptop.

### Step 1 — Start Flask

From the project root:

```bash
python ai_backend/app.py
```

Check the local health endpoint:

`http://127.0.0.1:5000/api/health`

The response should contain `"ok": true`.

### Step 2 — Start Cloudflare Tunnel

Install Cloudflare Tunnel for Windows:

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Open another terminal and run:

```bash
cloudflared tunnel --url http://127.0.0.1:5000
```

Copy the HTTPS URL ending in `trycloudflare.com`.

### Step 3 — Verify Public Backend

Open:

`https://YOUR-TUNNEL-URL.trycloudflare.com/api/health`

The endpoint should return the Flask backend health information.

### Step 4 — Connect the Render Frontend

In the Render frontend service, open Environment and configure:

| Key | Value |
|---|---|
| `VITE_API_BASE_URL` | Current Cloudflare HTTPS tunnel URL |

Save the environment variable and redeploy the frontend.

### Step 5 — Test the Website

1. Open the public Sentinel AI website.
2. Refresh the page.
3. Click Start Monitoring.
4. Allow webcam permission.
5. Test person and portable-object detection.
6. Verify the annotated feed and dashboard metrics.

Keep the Flask and Cloudflare terminals running during the demonstration.

**Availability limitation:** Cloudflare Quick Tunnels are temporary and have no uptime guarantee. The public backend becomes unavailable if the laptop shuts down, loses internet access, Flask stops, or the tunnel disconnects.

## Webcam Positioning and Zone Calibration

The laptop webcam is manually repositionable, not motorized.

1. Start monitoring.
2. Select the required zone.
3. Click at least three points on the live camera image.
4. Save the zone.
5. Recalibrate whenever the camera position changes.

Zone coordinates are normalized between 0 and 1.

## API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Backend health |
| `GET /api/status` | Monitoring status |
| `POST /api/browser/start` | Start browser webcam |
| `POST /api/browser/stop` | Stop browser webcam |
| `POST /api/frame` | Submit webcam frame for inference |
| `POST /api/camera/start` | Start backend camera |
| `POST /api/camera/stop` | Stop backend camera |
| `GET /api/video_feed` | Annotated video stream |
| `POST /api/upload` | Upload video for analysis |
| `GET /api/events` | Retrieve detection events |
| `PATCH /api/events/<id>` | Update event review status |
| `GET /api/config` | Retrieve configuration |
| `PUT /api/config` | Update configuration |

## Important Limitations

1. YOLOv8 detects generic objects; it does not recognize the act of stealing.
2. Object/person proximity does not establish ownership or intent.
3. Retail alerts are heuristic and do not integrate with POS/payment systems.
4. Home monitoring does not distinguish residents from visitors.
5. ByteTrack IDs can change due to occlusion, poor lighting or overlapping people.
6. Detection results require human review.
7. The public demonstration depends on the laptop and temporary Cloudflare tunnel.
8. The backend does not currently implement API authentication. Use test footage only and do not expose sensitive CCTV recordings through the public tunnel.

## Project Structure

```text
Smart-Anti-Theft-System/
├── ai_backend/
│   ├── app.py
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   └── style.css
│   └── package.json
├── config.json
├── setup-windows.bat
└──
