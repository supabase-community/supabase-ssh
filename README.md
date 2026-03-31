# supabase.sh

> Supabase docs over SSH

Give your agents shell access to Supabase documentation:

```bash
ssh supabase.sh <grep/cat/etc> /supabase/docs/...
```

Docs are up-to-date and served as markdown files so agents can explore them the same way they explore code.

## Setup

Tell your agent to check the Supabase docs before implementing features or fixing bugs:

```bash
ssh supabase.sh agents >> AGENTS.md # or CLAUDE.md, GEMINI.md, etc
```

This outputs a lightweight markdown snippet and appends it to the end of your `AGENTS.md` file. The snippet tells your agent to check the docs before working with Supabase, keeping it grounded in current docs and less likely to hallucinate.

## Why SSH?

Coding agents spend a lot of time in the shell. When exploring a codebase, they tend to reach for the same handful of tools: grep, find, ls, cat. These models are trained heavily on shell usage, so they treat the file system as a first-class interface. supabase.sh gives them that same interface for Supabase docs.

Traditional search interfaces (FTS, vector search) work too, but they're more opaque - the agent asks a question and gets back results without the ability to explore or navigate. With SSH, it can grep across docs, cat specific files, and use head and tail to skim without bloating its context window - the same way it would with any codebase.

## How does it work?

Under the hood, commands run inside Vercel's [just-bash](https://github.com/vercel-labs/just-bash) library - an emulated bash shell completely sandboxed within the Node.js runtime. It uses a virtual filesystem (VFS) where the Supabase docs are mounted as markdown files. When your agent runs commands over SSH, just-bash executes them within its emulated environment and returns the output without actually running them on a real shell.

## License

Apache 2.0. See [LICENSE](./LICENSE) for details.
