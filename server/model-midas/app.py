from flask import Flask, request, send_file, jsonify
from io import BytesIO
import os
from PIL import Image
import torch
import torchvision.transforms as transforms

app = Flask(__name__)

# Lazy-load MiDaS model from torch.hub on first request
model = None
transform = None

def load_model():
    global model, transform
    if model is not None:
        return
    # Use MiDaS v2.1 from intel-isl
    model = torch.hub.load("intel-isl/MiDaS", "MiDaS_small")
    model.eval()
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model.to(device)
    midas_transforms = torch.hub.load("intel-isl/MiDaS", "transforms")
    transform = midas_transforms.small_transform

@app.route('/predict', methods=['POST'])
def predict():
    try:
        if 'image' not in request.files:
            return jsonify({"error": "no image field (use multipart form field named 'image')"}), 400
        f = request.files['image']
        img = Image.open(f.stream).convert('RGB')
        load_model()
        input_batch = transform(img).unsqueeze(0)
        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        input_batch = input_batch.to(device)
        with torch.no_grad():
            prediction = model(input_batch)
            prediction = torch.nn.functional.interpolate(
                prediction.unsqueeze(1), size=img.size[::-1], mode='bicubic', align_corners=False
            ).squeeze()
            # normalize to 0..255
            pred = prediction.cpu().numpy()
            minv, maxv = pred.min(), pred.max()
            if maxv - minv > 1e-6:
                norm = (pred - minv) / (maxv - minv)
            else:
                norm = pred * 0.0
            depth_img = (norm * 255.0).astype('uint8')
            pil = Image.fromarray(depth_img)
            buf = BytesIO()
            pil.save(buf, format='PNG')
            buf.seek(0)
            return send_file(buf, mimetype='image/png')
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
