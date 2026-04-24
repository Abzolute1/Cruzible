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
ag1-pods agent qwen "What is the Fibonacci sequence?"
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
ag1-pods agent <name> "<message>"
```

## Environment

- `AG1_API_KEY`: API key used to secure vLLM endpoints.
- `AG1_CONFIG_DIR`: Local config directory, default `~/.ag1`.
- `HF_TOKEN`: Hugging Face token for model downloads.
