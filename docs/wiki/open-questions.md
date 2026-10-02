# Open questions

Known issues, blockers and verification gaps. Sources: `BEDROCK.md` (Known issues)
and `docs/raw/SURVIVAL-INTELLIGENCE.md` (Verification status).

## NetherNet instability

- The session drops every few seconds in some time slots (`Player disconnected`
  after 3-20 s, no server-side error). The harness reconnects itself, but during
  reconnection `/options` offers only `wait`.
- `connecterror:9` (InactivityTimeout) persists for hours at zero players; only a
  BDS restart clears it. One solved cause: mining via `item_stack_request` with
  invalid negative ids (fixed by reusing the crafting id sequence).

## Missing Bedrock capabilities (for the full first-night milestone)

- **Food beyond crops** — requires the furnace/smelting chain (exists, needs live
  testing of `eat` with hunger < 20 and food in inventory).
- **Advanced shelter** — no wall/shelter building actions.
- **Nether portal** — not implemented.

## Live verification pending

- `eat` and the container actions `read_container`/`take_<item>`/`deposit_<item>`
  are covered by unit tests but not yet verified live.
- A live `CURRICULUM=first_night` round on the BDS was not run (the bot container
  was connected; a concurrent session with the same account would kick it out).

## Design limitations

- **No real exploration**: the bot only "sees" ores within ~±40 loaded blocks (the
  96-block radar is capped by the actively requested subchunks) and has no random
  walk / strip mining / cave exploration. See
  [headless-client](headless-client.md#8-render-distance-not-comparable).
- **Placement** only on a top face adjacent to the bot; no scaling/orientation.
- **Crafting** only one item at a time; special recipes (smithing, anvil, looms)
  not implemented.

## Planned (not implemented)

- **Human chat command channel**: a natural-language remote-control channel via
  in-game chat (`@bot seguimi`, `@bot aiutami coi mob`). Chat is already received
  (packet `text` id 9) but ignored; linking a chat sender to a tracked player
  entity, a `follow_player` action, and allowlist-gated NL planning are still to
  build. Roadmap in [human-command](human-command.md).
