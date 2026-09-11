# Contributing to RustSCP

First off, thank you for considering contributing to **RustSCP**! It's people like you that make open-source software a vibrant community.

## Code of Conduct

Please treat everyone with respect, courtesy, and empathy. We are committed to providing a welcoming, inclusive, and harassment-free environment.

## How Can I Contribute?

### Reporting Bugs
Before creating bug reports, please check existing issues to ensure it hasn't been reported yet. When creating a bug report, please include:
- A clear, descriptive title.
- Steps to reproduce the issue.
- Expected behavior vs actual behavior.
- Operating system (macOS, Windows, Linux) and RustSCP version.
- Relevant logs or screenshots (ensure credentials and private keys are redacted!).

### Suggesting Enhancements
Feature suggestions are tracked as GitHub Issues. Please explain:
- Why this enhancement would be useful to users.
- How you envision the workflow or UI looking.
- Any architectural considerations (e.g., impact on SFTP or MCP protocol).

### Pull Requests
1. Fork the repository and create your branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Ensure dependencies are installed:
   ```bash
   pnpm install
   ```
3. Test your changes thoroughly:
   ```bash
   cargo test --all
   pnpm --dir apps/rustscp-desktop/ui build
   ```
4. Format and lint your code:
   ```bash
   cargo fmt --check
   cargo clippy --workspace --all-targets -- -D warnings
   ```
5. Commit your changes with clear, descriptive messages following Conventional Commits (e.g., `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`).
6. Push to your fork and submit a Pull Request against `main`.

## Development Guidelines

- **Memory Safety:** Do not introduce `unsafe` blocks in Rust unless strictly necessary for FFI, and always document the safety invariant.
- **Async Concurrency:** Use Tokio asynchronous primitives; avoid blocking operations on async worker threads.
- **UI Responsiveness:** Keep UI rendering smooth (60+ FPS). Keep heavy filesystem or network calculations inside Rust backend commands.
- **Localization:** Add i18n translation keys for both Portuguese (`pt-BR`) and English (`en-US`) in `apps/rustscp-desktop/ui/src/locales`.

Thank you for helping make RustSCP the best remote file manager in the world! 🦀
