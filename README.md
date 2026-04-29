# FounderOS (V8)
**The Ultimate Autonomous Multi-Agent AI Empire Architecture**

FounderOS is a state-of-the-art, parallel-execution multi-agent system designed to replace traditional corporate hierarchies with autonomous agent swarms. It orchestrates 27 specialized LLM workers concurrently across isolated workflows.

## 🚀 Getting Started

### Prerequisites
- **Python 3.10+**
- **GitHub CLI (`gh`)**: For repository management.
- **M4-Native Hardware (Recommended)**: Optimized for Apple Silicon via `mlx-lm`.
- **Telegram Bot**: For commanding the swarm.

### 📦 Installation

1. **Clone the repository** (if you haven't already):
   ```bash
   git clone <your-repo-url>
   cd FounderOS
   ```

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Setup Environment Variables**:
   Copy the example environment file and fill in your API keys:
   ```bash
   cp .c-suite/.env.example .c-suite/.env
   ```
   *Required Keys:*
   - `ANTHROPIC_API_KEY`: CEO model (Claude 3.5/4.5)
   - `GOOGLE_API_KEY`: Core & Research models (Gemini Pro/Flash)
   - `TELEGRAM_BOT_TOKEN`: Your bot token from @BotFather
   - `TELEGRAM_CHAT_ID`: Your target group ID

### 🛠️ Running FounderOS

Start the core 3-process architecture:
```bash
bash start.sh
```
This initiates:
1. **Local MLX Worker**: Qwen 2.5 7B server.
2. **Telegram Gateway**: The AIogram bot listener.
3. **APScheduler Registry**: Consolidated autonomous cron jobs.

To stop the system:
```bash
bash stop.sh
```

## 🏗️ Architecture Philosophy
FounderOS operates on a **4-Phase Coordinator Protocol**:
1. **Research**: Parallel workers fetch data concurrently.
2. **Synthesis**: Coordinator aggregates discoveries into a strict Specification.
3. **Implementation**: Write-heavy LLM implements the spec.
4. **Verification**: Gatekeeper agent reviews the output for quality assurance.

## 📚 Documentation
Detailed documentation can be found in the `docs/` directory:
- [**COMPLETE_REFERENCE.md**](docs/COMPLETE_REFERENCE.md): Exhaustive technical reference.
- [**AGENTS.md**](AGENTS.md): Machine-readable system constraints.
- [**DEPARTMENTS_ARCHITECTURE.md**](docs/DEPARTMENTS_ARCHITECTURE.md): Silo structures and data flow.

## 🛡️ Security
- **Tool Hooks**: Code-level policy enforcement preventing dangerous commands.
- **Sandboxing**: Destructive operations run in isolated worktrees.
- **Zero-Trust**: Per-agent tool manifests and data silos.

---
*Created by Pushkar Verma — 2026*
