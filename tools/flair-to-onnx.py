"""
FLAIR-INC RGB 15 classes (IGN, Etalab 2.0) to ONNX, with normalisation, softmax and argmax baked in.

    curl -L -o flair.pth https://huggingface.co/IGNF/FLAIR-INC_rgb_15cl_resnet34-unet/resolve/main/FLAIR-INC_rgb_15cl_resnet34-unet_weights.pth
    uv venv flair-env && VIRTUAL_ENV=flair-env uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
    VIRTUAL_ENV=flair-env uv pip install segmentation-models-pytorch onnx onnxscript onnxruntime
    flair-env/bin/python -I tools/flair-to-onnx.py flair.pth data/models/flair-rgb15.onnx

The checkpoint is opened with weights_only=True: tensors only, no code from the file runs.
Tested with torch 2.15, segmentation-models-pytorch 0.6, onnx 1.23. The result checks itself against PyTorch at the end.
"""
import sys, torch, segmentation_models_pytorch as smp
src, dst = sys.argv[1], sys.argv[2]
sd = torch.load(src, map_location="cpu", weights_only=True)
sd = {k[len("model.seg_model."):]: v for k, v in sd.items() if k.startswith("model.seg_model.")}
net = smp.Unet(encoder_name="resnet34", encoder_weights=None, in_channels=3, classes=19)
net.load_state_dict(sd, strict=True)
net.eval()
MEAN = torch.tensor([105.08, 110.87, 101.82]).view(1, 3, 1, 1)
STD = torch.tensor([52.17, 45.38, 44.0]).view(1, 3, 1, 1)
class Wrapped(torch.nn.Module):
    def __init__(self, net):
        super().__init__(); self.net = net
    def forward(self, rgb):  # rgb: float32 [1,3,H,W] in 0..255, H and W multiples of 32
        logits = self.net((rgb - MEAN) / STD)
        prob = torch.softmax(logits, dim=1)
        conf, cls = prob.max(dim=1)
        return cls.to(torch.uint8), (conf * 255).round().to(torch.uint8)
w = Wrapped(net).eval()
x = torch.rand(1, 3, 512, 512) * 255
torch.onnx.export(w, (x,), dst, input_names=["rgb"], output_names=["class", "confidence"],
                  dynamic_axes={"rgb": {2: "h", 3: "w"}, "class": {1: "h", 2: "w"}, "confidence": {1: "h", 2: "w"}},
                  opset_version=17, dynamo=False)
import onnxruntime as ort, numpy as np
s = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
c, p = s.run(None, {"rgb": x.numpy()})
with torch.no_grad(): rc, rp = w(x)
print("ok", c.shape, c.dtype, "agreement", float((torch.from_numpy(c) == rc).float().mean()))
