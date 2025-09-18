Model server integration

This project includes a minimal MiDaS-based depth server in `server/model-midas` that exposes `/predict`.

Quick start (local):
1. Build the container:
   ```bash
   cd server/model-midas
   docker build -t maplook-midas:latest .
   ```
2. Run the container:
   ```bash
   docker run --rm -p 5000:5000 maplook-midas:latest
   ```
3. Set the proxy to forward depth requests to this service. Run the main proxy with environment variable:
   ```bash
   DEPTH_MODEL_URL=http://host.docker.internal:5000/predict npm start
   ```
   - On Linux you can use `http://localhost:5000/predict`.

Client flow:
- Use the UI "Run Server Depth" button. It uploads the image to `/upload-image` then calls `/depth` which forwards to the configured `DEPTH_MODEL_URL`.
- The MiDaS server returns a PNG depth map; the proxy will simply forward that PNG back to the client. The client attempts to render the returned PNG as a heightmap.

Notes:
- For production or better performance, use a GPU image and install matching PyTorch/CUDA builds in the Dockerfile.
- The MiDaS model is pre-trained and may not output absolute metric depth — it produces relative depth maps suitable for visualization and reconstruction with appropriate scaling.
