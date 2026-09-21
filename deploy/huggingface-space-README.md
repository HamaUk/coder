# Hama AI Support Agent

A self-hosted AI support agent console that answers questions, searches the web,
and writes code into a per-conversation workspace.

<!--
  For a Hugging Face Space: paste the three lines below at the very top of this
  README in the Space's own repository. A Space reads its SDK and port from this
  front matter, and without it the Dockerfile is ignored. (Do not add it to the
  GitHub copy of this file — it means nothing there.)
-->

```yaml
---
title: Hama AI Support Agent
sdk: docker
app_port: 3000
---
```

## Deploying to a Space

1. Create a Space at huggingface.co/new-space → **SDK: Docker** → hardware **CPU basic (free)**.
2. Add this repository's files to it (the `Dockerfile` is used as-is).
3. Prepend the front-matter block above to the Space's `README.md`.
4. Settings → **Variables and secrets** → add `HAMA_TOKEN` as a **secret**.
   The console refuses to start on a public interface without it.
5. Open the Space, sign in with that token.

Free Spaces sleep after a period without traffic and wake on the next request, so
the first load after a quiet spell is slow. The container's filesystem is also
reset on every rebuild or restart: chats, providers and generated files do not
survive. Use a host with a disk if that matters — see the deployment section of
the main README.
