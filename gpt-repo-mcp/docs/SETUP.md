# Setup

## Install ngrok from zero

macOS:

```bash
brew install ngrok
```

Linux:

```bash
sudo apt install ngrok
```

Windows:

Download ngrok from the official site, add it to `PATH`, then confirm it is available:

```bash
ngrok help
```

Start the convenience connector flow with:

```bash
npm run connect
```

## Starter Config

Create a local config from the empty starter:

```bash
cp config.example.json config.local.json
```

The starter config is intentionally empty. Add the first approved repository with:

```bash
npm run add -- /path/to/your/repo
```

If no repository has been added yet, `doctor` may report `WARN config has no repositories`.

Use explicit `read`, `write`, or `ship` mode when automation cannot prompt. The generic form is `npm run add -- <path> --mode <mode>`:

```bash
npm run add -- <path> --mode <mode>
```
