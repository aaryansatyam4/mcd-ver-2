FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch keeps the image small (the default PyPI wheel bundles several GB of CUDA libraries)
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision

RUN pip install --no-cache-dir \
    ultralytics \
    fastapi \
    uvicorn \
    pillow

COPY detect_server.py yolo26n.pt ./

ENV PORT=5002
ENV HOST=0.0.0.0
ENV YOLO_MODEL=yolo26n.pt

EXPOSE 5002

CMD ["python", "detect_server.py"]
