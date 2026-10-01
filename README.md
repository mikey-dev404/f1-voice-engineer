# F1 25 voice race engineer

A transparent overlay that sits on top of F1 25, reads your live UDP telemetry, and answers you out loud when you hold a button on your wheel.

- **Push to talk on the wheel.** F1 25 swallows the keyboard while it has focus, so the radio button is a real button on your Moza (or any) wheel, read straight from HID.
- **Free voice.** Uses Google Gemini Live on the free AI Studio tier. No OpenAI, no card.
- **It actually sees the car.** Tyres, wear, temps, fuel delta, ERS, damage, gaps, penalties, weather and safety car go to the engineer at the moment you press the button.

---

## Requirements

- **Windows PC running F1 25** (the game is Windows only; the overlay must run on the same PC)
- **Node.js 20 or newer** — <https://nodejs.org>
- A free **Gemini API key** — <https://aistudio.google.com/apikey>
- A wheel with a spare button. Built for the **Moza R5**, works with any HID wheel or gamepad.

---

## Install

```bash
npm install
npm start
```

The settings window opens on first run.

> If `npm install` warns that install scripts were blocked, run `npm approve-scripts electron esbuild node-hid` and then `npm install` again. That is npm 11's security prompt, not an error in this project.

---

## Setup, in order

### 1. Gemini key

Paste your free key from [AI Studio](https://aistudio.google.com/apikey) into settings. Pick a voice — `Charon` and `Fenrir` sound closest to a pit wall engineer.

On the free tier Google may use the audio to improve their products. If that matters to you, use a paid key.

### 2. Bind your radio button

In settings, pick your wheel, press **Bind a button**, then:

1. Leave the wheel alone for a second while it reads the resting state.
2. When it says so, **hold the button you want**.

Use a spare face button, not a shift paddle or the clutch. The app works out which bit in the HID report that button is, so it does not care what wheel you own.

**Then remove that button from your F1 25 controls**, or the game will also act on it.

If your wheel is not in the list, tick **Show every USB device** and look for it there.

### 3. F1 25 telemetry

In game: **Settings → Telemetry Settings**

| Setting | Value |
| --- | --- |
| UDP Telemetry | On |
| UDP Broadcast Mode | Off |
| UDP IP Address | `127.0.0.1` |
| UDP Port | `20777` |
| UDP Send Rate | 20Hz or higher |
| UDP Format | **2025** |
| Your Telemetry | Public (so the engineer can see your own car data) |

Only one program can listen on port 20777. If you also run SimHub, CrewChief or similar, they will fight over it — close the other one, or change the port in both the game and this app.

### 4. Graphics

Set F1 25 to **Borderless** (Graphics → Display Mode). Exclusive fullscreen will draw over the overlay.

---

## Using it

Hold your bound button, speak, let go. The engineer answers a moment later.

```
"how are my tyres"
"should I box this lap"
"what's the gap to the car behind"
"how much fuel do I have"
"is it going to rain"
"what damage have I got"
```

The overlay stays dim while you drive and lights up when you talk. It is click-through, so it never steals your mouse.

**Hold the radio button for 1.5 seconds** to open settings without leaving the car. `Ctrl+Shift+F1` does the same from the desktop.

The strip along the bottom always shows position, lap, tyre and age, worst tyre wear, fuel delta, ERS and the gap ahead. Wear and fuel turn amber then red as they get serious.

---

## Testing without the game

You can run the whole thing on a machine that cannot play F1 25.

```bash
node scripts/replay-udp.mjs     # synthetic race on port 20777
npm start                       # in another terminal
```

Other tools:

```bash
node scripts/check-telemetry.mjs      # decode live packets, print the engineer's brief
node scripts/record-udp.mjs           # capture real packets to captures/
node scripts/replay-udp.mjs captures/f1-1234.bin   # play a capture back
```

---

## When something is wrong

The three pills at the top of the overlay tell you which part is unhappy.

| Symptom | Cause |
| --- | --- |
| **UDP** says `waiting` | App is listening but the game is not sending. Recheck the telemetry settings and that the port matches. |
| **UDP** says `port busy` | Another telemetry app already owns the port. Close it or change the port. |
| **UDP** says `wrong format` | UDP Format is set to 2023 or 2024. Set it to 2025. |
| **PTT** says `not bound` | Bind a button in settings. |
| **PTT** says `wheel offline` | Wheel is off or unplugged. It reconnects on its own. |
| **PTT** says `unavailable` | `node-hid` failed to load. Run `npm run rebuild`. |
| **ENGINEER** says `error` | The caption shows why — usually a bad key, a model your key cannot use, or the free rate limit. |
| Engineer hears nothing | Check Windows has the right default microphone and that the app has mic permission. |

If the model name is rejected, pick a different one in settings. Google renames Live API preview models fairly often.

Launching from a VS Code or Cursor terminal used to break Electron because those terminals set `ELECTRON_RUN_AS_NODE=1`; `npm start` strips it.

---

## How it works

```
F1 25  ──UDP 20777──▶  main process ──▶ snapshot ──▶ telemetry brief
Moza wheel ──HID──▶    main process ──▶ push-to-talk events
                                  │
                          overlay renderer
                                  │
                   mic ──▶ Gemini Live ──▶ speakers
```

- `src/telemetry/parser.ts` decodes the F1 25 packet layout by hand. Every struct is packed little-endian, which the documented packet sizes confirm.
- `src/telemetry/snapshot.ts` folds the 60Hz stream into one small player-centric object.
- `src/telemetry/brief.ts` turns that into the text block the model reads, plus the engineer's system prompt.
- `src/main/ptt.ts` reads HID reports directly. It learns your button by diffing reports against an idle baseline, so no per-wheel configuration is needed.
- `src/renderer/gemini-live.ts` runs the Live session with automatic voice detection **off** — the wheel button sends `activityStart` and `activityEnd`, which is exactly push-to-talk.

The telemetry brief is sent inside the same turn as your voice, so the model always answers against the car as it is at that moment rather than something it remembers from three corners ago.

---

## Notes and limits

- The model is told never to invent numbers, and to say so when telemetry is missing. It can still be wrong about strategy — it is an opinion, not the pit wall.
- Sessions reconnect on their own during long races and resume the conversation where possible.
- Nothing is uploaded except your voice and the telemetry brief, and only while you hold the button.
- Your API key is stored in Electron's `userData` folder on your machine, not in this repo.
