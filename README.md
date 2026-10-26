# WheelWash Monitor — Truck Counting & CCTV Monitoring System

Production-oriented Wheel Wash Truck Counting & Monitoring System for MCD municipal landfill and facility locations:
1. **GHAZIPUR** (Location 1)
2. **OKHLA** (Location 2)
3. **BHALASWA** (Location 3)

The system automatically monitors three wheel-wash locations using CCTV / RTSP cameras or connected device/Bluetooth/USB cameras, applies intelligent **Vehicle vs Human** spatial classification, and automatically increments the truck counter whenever a valid truck passage is verified.

---

## 🚀 Quick Start — How to Run

### Option 1: Run Both Backend and Frontend with One Command
From the project root (`/Users/aryansatyam/Desktop/Pesi/MCD`):
```bash
npm run dev
```

---

### Option 2: Run in Two Separate Terminal Windows (Recommended)

#### Terminal 1 — Start Backend Server:
```bash
cd /Users/aryansatyam/Desktop/Pesi/MCD/backend
npm run dev
```
- **Backend API & WebSockets:** `http://localhost:5001`
- **Excel Database File:** `backend/public/database.xlsx`
- **Excel Download URL:** `http://localhost:5001/public/database.xlsx`

#### Terminal 2 — Start Frontend Server:
```bash
cd /Users/aryansatyam/Desktop/Pesi/MCD/frontend
npm run dev
```
- **Frontend Web Dashboard:** Open `http://localhost:5173` in your browser.

---

## 📹 Real Camera Connections (Webcam, USB, Bluetooth, RTSP)

Each location panel features an **Open Camera** button:
- **Device Cameras:** Connect your laptop webcam, external USB camera, or Bluetooth/wireless camera with one click.
- **Instant Control Room Sync:** When an operator or admin connects their camera in Okhla (or Ghazipur / Bhalaswa), the live stream is immediately shared across all control room screens in real time.
- **RTSP / IP Camera Support:** Configure network RTSP URLs in the **Camera Settings** console.

---

## 🧠 AI Classification: Heavy Truck vs. Human / Pedestrian (YOLO26)

Every **real camera frame** (device webcam / USB / Bluetooth, or RTSP CCTV) is classified on the server by the
YOLO26 object detector (`backend/yolo/detect_server.py` + `yolo26n.pt`). Pixel-motion guesses are **not** used for
counting, so a person walking past or standing close to the camera can never increment the counter.

1. **Only trucks count:** a `truck` (or `bus`, for large tippers) box with confidence ≥ 0.45 that overlaps the
   wheel-wash ROI. Cars and every other class are ignored.
2. **People never count:** `person` boxes are shown as `HUMAN_IGNORED` (amber). A truck still counts when the driver or a
   washer is visible next to it. A "truck" box that is really the same box as a more confident person is dropped.
3. **Count once per truck:** the truck must be confirmed on at least 2 frames, then the bay must be free of trucks for
   `cooldownSeconds` before the next truck can be counted. A truck parked in the bay while it is washed counts once.
4. **Fail safe:** if the YOLO detector is offline, live cameras show *"AI DETECTOR OFFLINE — AUTOMATIC COUNTING PAUSED"*
   and nothing is counted until it is back.
5. **Secure ingest:** only the Master Admin or the operator assigned to that location can stream a device camera into it.

### Running the YOLO detector

- **Local / PM2:** the backend starts `python3 backend/yolo/detect_server.py` automatically on port 5002
  (`pip install ultralytics fastapi uvicorn pillow` first). Set `YOLO_PYTHON` to use a virtualenv's python.
- **Docker:** `docker compose up` runs it as the separate `yolo` service (`YOLO_URL=http://yolo:5002`).
- **Render:** the backend's Node runtime has no Python, so YOLO must run as its own Docker web service
  (`wheelwash-yolo` in `render.yaml`). If you create it by hand, set *Dockerfile Path* to `backend/yolo/Dockerfile`
  **and** *Docker Build Context Directory* to `backend/yolo` (the Dockerfile copies `detect_server.py` and
  `yolo26n.pt` from that folder), pick a paid instance (PyTorch does not fit the free plan), then set
  `YOLO_URL=https://<your-yolo-service>.onrender.com` and `YOLO_AUTOSTART=false` on the backend.
  `GET /api/health` reports `yolo.online` so you can check the link.
- Tunables (see `backend/.env.example`): `YOLO_URL`, `YOLO_VEHICLE_CLASSES`, `YOLO_TRUCK_MIN_CONF`, `YOLO_PERSON_MIN_CONF`.

The virtual demo feed (Demo Control Bar) is simulated and keeps working without YOLO.

---

## 🔑 Login Accounts (Password for all: `123456`)

| Username | Initial Password | Role | Access Scope |
|---|---|---|---|
| **admin** | `123456` | Master Admin | Full control: view all 3 sites, live cameras, configure cameras & ROI detection, user management, audit logs. |
| **monitoring** | `123456` | Central Monitoring | View-only access: all 3 live camera feeds, individual counters, combined total, reports, exports. |
| **ghazipur** | `123456` | Ghazipur Operator | Restricted to Ghazipur only: Ghazipur camera feed, counter, and Ghazipur reports. |
| **okhla** | `123456` | Okhla Operator | Restricted to Okhla only: Okhla camera feed, counter, and Okhla reports. |
| **bhalaswa** | `123456` | Bhalaswa Operator | Restricted to Bhalaswa only: Bhalaswa camera feed, counter, and Bhalaswa reports. |

*Direct login enabled with zero forced password change prompts.*

---

## 📗 Google Sheet Database (recommended for Render)

The backend can keep all its data in a Google Sheet. It loads everything from the sheet when it starts and writes each change back within about 2 seconds, so nothing is lost when Render restarts or redeploys the server (the free plan wipes the local disk each time).

**One-time setup (about 5 minutes):**

1. Create a new, empty Google Sheet ([sheets.new](https://sheets.new)).
2. In the sheet: **Extensions → Apps Script**. Delete the sample code and paste the whole of [`google-apps-script.js`](google-apps-script.js).
3. Optional but recommended: put a password between the quotes in `var SECRET_KEY = '';`.
4. Click **Save**, then **Deploy → New deployment → ⚙ → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and allow access when Google asks.
5. Copy the **Web app URL** (it ends in `/exec`).
6. On Render, open **wheelwash-backend → Environment** and add:
   - `GOOGLE_SCRIPT_URL` = the Web app URL
   - `GOOGLE_SCRIPT_SECRET` = the same password as `SECRET_KEY` (skip if you left it empty)

   Save; Render redeploys. For local runs put the same two lines in `backend/.env`.

On the first start the backend copies the existing data into the sheet. After that the sheet is the database:

| Tab | Contents |
|---|---|
| `Dashboard` | Today's truck count per site and the total (refreshed on every change and every 5 minutes) |
| `vehicle_events` | Every truck passage |
| `count_adjustments` | Manual count corrections |
| `audit_logs` | Audit trail |
| `users`, `locations`, `cameras` | Accounts (hashed passwords), sites, camera settings |

- Make changes through the app. If you edit the data tabs by hand, restart the backend so it reloads them.
- If Google can't be reached, changes are kept in memory and retried automatically until they are saved.
- `GET /api/health` shows `database.mode` (`google-sheets` or `excel`), the last sync time, pending changes and any error. When the sheet is connected, the **Google Sheet** button in the top bar opens it.
- After editing the Apps Script, use **Deploy → Manage deployments → Edit → Version: New version → Deploy** so the URL stays the same.

---

## 📊 Local Excel Storage (`backend/public/database.xlsx`)

Without `GOOGLE_SCRIPT_URL`, records are stored in Microsoft Excel format in `backend/public/database.xlsx` (with the Google Sheet connected, this file is kept as a local cache):

- **Worksheets:**
  1. `users`: Account credentials, hashed passwords, roles, location IDs.
  2. `locations`: Ghazipur, Okhla, Bhalaswa.
  3. `cameras`: Camera configs, RTSP URLs, detection ROI, sensitivity settings.
  4. `vehicle_events`: Timestamped vehicle passage detections.
  5. `count_adjustments`: Historical adjustments.
  6. `audit_logs`: Detailed non-repudiation audit trails (excluding manual adjustments).

You can directly open `backend/public/database.xlsx` in Microsoft Excel anytime or click the **Excel Database** download button in the top navigation bar.

---

## 🧪 Automated Test Suite
```bash
cd /Users/aryansatyam/Desktop/Pesi/MCD/backend
npm run test
```
All 30 integration and unit tests pass:
- Login authentication & role-based restrictions
- Location-level access control (operators blocked from other sites)
- **Human vs Heavy Truck classification** with YOLO26 (people never counted, truck counted once, nothing counted when the AI is offline)
- Motion detection state machine & cooldown duplicate prevention
- Clean audit history
- Daily, Weekly, Monthly, and Yearly reports in Asia/Kolkata timezone
- CSV and Excel export downloads
