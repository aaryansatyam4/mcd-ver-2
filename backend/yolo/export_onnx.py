"""
Export the YOLO26 model to ONNX for on-device (in-browser) detection.

The browser runs the model with onnxruntime-web (frontend/src/ai/yoloBrowser.ts). Camera frames
are 640x360, so the model is exported for a 384x640 input (360 + 12px letterbox padding top and
bottom) instead of the default 640x640, which keeps phones fast.

Non-maximum suppression is built into the graph (nms=True; the weights in yolo26n.pt are a YOLOv8n
model, which is not NMS-free), so the exported model outputs [1, 300, 6] rows of
x1, y1, x2, y2, score, class, the same boxes the server sidecar returns.

Run once after changing the model, then bump the version in MODEL_URL (yoloBrowser.ts) so every
device downloads the new file:

    pip install ultralytics onnx onnxslim
    python export_onnx.py
"""
import os
import shutil

from ultralytics import YOLO

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(BASE_DIR, "yolo26n.pt")
TARGET = os.path.join(BASE_DIR, "..", "..", "frontend", "public", "models", "yolo26n-v1.onnx")

if __name__ == "__main__":
    exported = YOLO(SOURCE).export(
        format="onnx", imgsz=[384, 640], opset=17, simplify=True, nms=True, conf=0.25, iou=0.7, max_det=300
    )
    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    shutil.move(exported, TARGET)
    print(f"[yolo] exported {os.path.normpath(TARGET)} ({os.path.getsize(TARGET) / 1e6:.1f} MB)")
