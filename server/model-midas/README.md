MiDaS small depth server

This is a minimal Flask wrapper around the MiDaS small model (intel-isl/MiDaS) to provide a simple /predict endpoint.

Build (recommended on machine with enough RAM; GPU recommended for speed):

```bash
cd server/model-midas
docker build -t maplook-midas:latest .
```

Run:

```bash
docker run --rm -p 5000:5000 maplook-midas:latest
```

Usage:
- POST multipart/form-data with field `image` to http://localhost:5000/predict
- Returns PNG image of normalized depth map (0..255)

Notes/Limitations:
- This image-to-depth server uses a pre-trained model downloaded at runtime via torch.hub. The first request will download weights.
- Torch and model loading may be slow on CPU. Use a GPU-enabled base image and install appropriate CUDA/PyTorch builds for better performance.
- The output is a normalized 8-bit depth map suitable for visual heightmap reconstruction.
