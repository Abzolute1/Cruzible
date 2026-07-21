# AG1 Pods

AG1 Pods manages remote GPU pods for OpenAI-compatible model serving. It keeps pod state locally, installs model runtime dependencies over SSH, starts vLLM servers, and routes AG1 agent traffic to the selected pod.

## Install

```bash
npm install -g @ag1/pods
```

## Quick Start

```bash
export HF_TOKEN=your_huggingface_token
export AG1_API_KEY=your_api_key

ag1-pods pods setup dc1 "ssh root@1.2.3.4" --models-path /workspace
ag1-pods start Qwen/Qwen2.5-Coder-32B-Instruct --name qwen
ag1-pods list
```

## Commands

```bash
ag1-pods pods setup <name> "<ssh>" [options]
ag1-pods pods
ag1-pods pods active <name>
ag1-pods pods remove <name>
ag1-pods shell [<name>]
ag1-pods ssh [<name>] "<command>"

ag1-pods start <model> --name <name> [options]
ag1-pods stop [<name>]
ag1-pods list
ag1-pods logs <name>
```

## Environment

- `AG1_API_KEY`: API key used to secure vLLM endpoints.
- `AG1_CONFIG_DIR`: Local config directory, default `~/.ag1`.
- `HF_TOKEN`: Hugging Face token for model downloads.
- `AG1_STARTUP_TIMEOUT_MINUTES`: Max time to wait for vLLM startup (default `15`).

## Security

vLLM endpoints are exposed over **cleartext HTTP** with a single static bearer
key (`AG1_API_KEY`). Anyone on the network path can read traffic and reuse the
key. Treat the key as only a light access control and prefer reaching models
through an SSH tunnel instead of the public address:

```bash
ssh -N -L 8001:localhost:8001 <pod-host>
export OPENAI_BASE_URL="http://localhost:8001/v1"
```

For anything beyond trusted networks, put the endpoint behind TLS (e.g. a
reverse proxy) instead of relying on the built-in key check.
