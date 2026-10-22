# Cloudflare Code Mode bridge (optional, off by default)

Cloudflare documents Code Mode as experimental and publishes no HTTP API for it, so ProofLoop does not call Cloudflare directly. Instead it ships a **bridge**: an adapter that talks to a Worker you deploy, using a small contract ProofLoop defines. The Worker is where the model-written program runs (for example on Cloudflare's Code Mode library).

**Verification status:** the bridge is tested against a local mock of this contract (`tests/cloudflare.test.ts`). It has not been run against a real Cloudflare deployment, and no reference Worker is shipped. Treat it as unverified until you try it.

## What leaves your machine
The program text, the tool schemas and **the results of every tool call** (file excerpts, search hits, issue bodies, gate summaries) are sent to your Worker, because the program runs there and processes those results. Results are bounded and secret-redacted by the host before sending, but this is repository content leaving the machine. That is why enabling needs two explicit acknowledgements.

## Enabling
```bash
export PROOFLOOP_CODEMODE_CLOUDFLARE=1
export PROOFLOOP_CODEMODE_CF_ACK_DATA_FLOW=1      # I understand tool results are sent to my Worker
export PROOFLOOP_CODEMODE_CF_URL=https://your-worker.example.workers.dev
export PROOFLOOP_CODEMODE_CF_TOKEN=...            # required for non-localhost
```
Plain `http` is accepted only for localhost (for testing). Without all of these the adapter reports why it is unavailable and runs nothing. The engine and protocols never use it.

## Wire contract
```
POST {url}/run     {program, tools:[{name,mode,description,input}], limits:{maxCalls,maxDurationMs}}  -> {session, event}
POST {url}/resume  {session, id, ok:true, value} | {session, id, ok:false, error}                     -> {event}
event = {type:'call', id, name, args} | {type:'done', value} | {type:'error', message}
```
The Worker must run the program with a `tools` object whose methods emit `call` events and wait for `resume`. ProofLoop answers every call itself.

## What ProofLoop enforces regardless of the Worker
All tool rules live on the host in one place (`src/composer/host.ts`, shared with the local sandbox): unknown tools are refused, mutating tools need per-run authorization, inputs are validated against the schema, results are size-capped and redacted, calls are counted on receipt, and wall-clock time is limited. A misbehaving Worker can at worst return a wrong value or hang until the time limit.
