# Gemma 4 31B Swap Instructions

## What changes
- Port 8000: Mistral-Small-3.1-24B-FP8 -> google/gemma-4-31B-it
- Port 8001: Qwen VL 7B stays the same
- MMCP container: unchanged (port 5000)

## VRAM Budget (H100 80GB)
- Gemma 4 31B (bfloat16): ~62GB at max
- With gpu-memory-utilization=0.45: ~36GB for Gemma
- Qwen VL 7B: ~14GB
- Total: ~50GB -- leaves headroom for MMCP and system

## Steps

### 1. Accept Gemma license
Go to https://huggingface.co/google/gemma-4-31B-it
Click "Agree and access repository"

### 2. Set HF_TOKEN on VM
```bash
ssh ubuntu@89.169.122.36
export HF_TOKEN=your_huggingface_token
echo "HF_TOKEN=$HF_TOKEN" >> /opt/mmcp/.env
```

### 3. Stop Mistral container
```bash
docker stop mmcp-vllm-reasoning-1
docker rm mmcp-vllm-reasoning-1
```

### 4. Pull and start Gemma 4
```bash
cd /opt/mmcp
# Update docker-compose.yml with the new vllm-reasoning service config
# Or run standalone:
docker run -d \
  --name mmcp-vllm-reasoning-1 \
  --gpus all \
  --ipc host \
  -p 8000:8000 \
  -v /root/.cache/huggingface:/root/.cache/huggingface \
  -e HF_TOKEN=$HF_TOKEN \
  -e PYTORCH_ALLOC_CONF=expandable_segments:True \
  vllm/vllm-openai:latest \
  --model google/gemma-4-31B-it \
  --served-model-name gemma4-31b \
  --host 0.0.0.0 \
  --port 8000 \
  --tensor-parallel-size 1 \
  --dtype bfloat16 \
  --max-model-len 16384 \
  --max-num-seqs 16 \
  --gpu-memory-utilization 0.45 \
  --enable-chunked-prefill \
  --enable-prefix-caching \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --trust-remote-code

# First run will download ~60GB of model weights. Takes 10-20 min.
```

### 5. Verify
```bash
curl http://localhost:8000/v1/models
# Should return gemma4-31b

curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4-31b","messages":[{"role":"user","content":"Hello"}],"max_tokens":50}'
# Should return a response
```

### 6. Update code-router
The Supabase edge function code-router currently references the model name.
Update any model name references from "mistral" to "gemma4-31b".
The endpoint URL (port 8000) stays the same.

## Rollback
If Gemma 4 doesn't work:
```bash
docker stop mmcp-vllm-reasoning-1
docker rm mmcp-vllm-reasoning-1
# Re-run the original Mistral container
```
