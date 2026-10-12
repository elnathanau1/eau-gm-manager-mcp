# eau-gm-manager-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server that connects a **Speediance Gym Monster**
account to Claude. Ask Claude to review your training, look up exercises, and build custom workouts
that show up on the machine, without a GM Manager subscription.

> **Unofficial.** Speediance has no public developer API. This server talks to the same private API
> the Speediance phone app uses, signing in with your Speediance email and password. It isn't
> affiliated with or endorsed by Speediance, it may stop working whenever their backend changes, and
> using it may be against their terms of service. Use it with your own account only, at your own risk.

## What Claude can do with it

| Area | Tools |
| --- | --- |
| Account | `check_connection` |
| Training review | `get_training_history`, `get_session_detail`, `get_training_stats`, `get_calendar`, `get_exercise_history` |
| Exercise library | `list_exercises`, `get_exercise` |
| Custom workouts | `list_my_workouts`, `get_workout`, `create_workout`, `update_workout`, `delete_workout` |
| Scheduling | `schedule_workout`, `unschedule_workout` |

Example prompts:

- "Look at my last 4 weeks of training and tell me which muscle groups I'm neglecting."
- "Build me a 45-minute upper-body workout based on my recent loads and schedule it for Thursday."
- "How has my bench press progressed since summer?"

Weights are always in your account's display unit (lb or kg). `create_workout` and `update_workout`
read the saved template back from Speediance and report `verified: false` if anything doesn't match.

## Setup

Requirements: Node.js 20 or newer, and a Speediance account **with a password** (if you sign in with
Google or Apple, set a password in the Speediance app first).

```bash
git clone https://github.com/elnathanau1/eau-gm-manager-mcp.git
cd eau-gm-manager-mcp
npm install
npm run build
```

### Connect it to Claude Desktop

Open Claude Desktop → Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "speediance": {
      "command": "node",
      "args": ["/absolute/path/to/eau-gm-manager-mcp/dist/index.js"],
      "env": {
        "SPEEDIANCE_EMAIL": "you@example.com",
        "SPEEDIANCE_PASSWORD": "your-speediance-password",
        "SPEEDIANCE_UNIT": "lb"
      }
    }
  }
}
```

Restart Claude Desktop, then ask Claude to "check my Speediance connection".

### Connect it to Claude Code

```bash
claude mcp add speediance \
  -e SPEEDIANCE_EMAIL=you@example.com \
  -e SPEEDIANCE_PASSWORD='your-speediance-password' \
  -e SPEEDIANCE_UNIT=lb \
  -- node /absolute/path/to/eau-gm-manager-mcp/dist/index.js
```

### Signing in without putting your password in a config file

Run `node dist/index.js login` once. It prompts for your email and password and saves only the
session token, in `~/.eau-gm-manager-mcp/session.json` (permissions 0600). Then leave
`SPEEDIANCE_PASSWORD` out of the config. The catch: once that token expires, you have to run `login`
again. With the password in the config, the server renews the session automatically.

`node dist/index.js logout` deletes the saved session.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEEDIANCE_EMAIL` | | Account email |
| `SPEEDIANCE_PASSWORD` | | Account password. Lets the server renew expired sessions |
| `SPEEDIANCE_UNIT` | | `lb` or `kg`. Must match the Speediance app (see below) |
| `SPEEDIANCE_REGION` | `Global` | `Global`, or `EU` for accounts on Speediance's EU servers |
| `SPEEDIANCE_CLIENT_TYPE` | `bike` | Which session slot the login uses (see below) |
| `SPEEDIANCE_DEVICE_TYPE` | `1` | `1` = Gym Monster. Other devices are untested |
| `SPEEDIANCE_MCP_HOME` | `~/.eau-gm-manager-mcp` | Where the session and exercise-library cache are stored |

**Session slots.** Speediance allows one live login per *client type*: phone app, Gym Monster,
Gym Nano, bike. A new login signs out whatever else holds that slot. This server signs in as the
`bike` client by default, so it won't sign out your phone or your Gym Monster. If you own a
Speediance bike, set `SPEEDIANCE_CLIENT_TYPE=nano` instead.

**Units.** Only a login with the `phone` client type reports whether the account uses lb or kg, so
set `SPEEDIANCE_UNIT` to whatever the Speediance app shows. If it's wrong, workout weights will be off
by a factor of 2.2.

## Development

```bash
npm test          # unit tests plus MCP end-to-end tests against a fake Speediance backend
npm run typecheck
npm run build
```

Layout:

- `src/client.ts`: HTTP client (app headers, login, session renewal, throttling). If Speediance
  changes something and requests start failing, this is the first place to look.
- `src/api.ts`: endpoint wrappers (history, sessions, templates, scheduling, exercise library).
- `src/templates.ts`: builds and verifies custom-workout payloads.
- `src/library.ts`: exercise search and name matching.
- `src/server.ts`: the MCP tools.

The first `list_exercises` call downloads the whole exercise library (about 1,000 movements, spread
over dozens of requests at one request per second), so it can take a minute. The library is then
cached for 24 hours.

## Credits

The protocol details come from community reverse-engineering, mainly
[labatt/speediance-mcp](https://github.com/labatt/speediance-mcp) (MIT),
[stozo04/speediance-cli](https://github.com/stozo04/speediance-cli), and
[hbui3/UnofficialSpeedianceWorkoutManager](https://github.com/hbui3/UnofficialSpeedianceWorkoutManager).
If you want more features (coaching memory, strength profiles, heart-rate data, remote access from
claude.ai), labatt/speediance-mcp is a more complete free alternative.

## License

MIT
