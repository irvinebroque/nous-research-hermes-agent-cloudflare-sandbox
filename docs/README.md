# Publishing the Cloudflare docs page

`hermes.mdx` is a self-contained how-to for:

```text
src/content/docs/sandbox/coding-agents/hermes.mdx
```

in [cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs). Its public URL will be `https://developers.cloudflare.com/sandbox/coding-agents/hermes/`.

The existing `/sandbox/coding-agents/` URL is the overview. `coding-agents-index.patch` adds a Hermes card there and adjusts the introduction so it accommodates this standalone example. It does not replace the overview.

The draft explains deployment and links to the [example repository](https://github.com/irvinebroque/nous-research-hermes-agent-cloudflare-sandbox) in its related resources. The repository is private; make it public before publishing that link in the Cloudflare docs.

Before publishing:

1. Copy `hermes.mdx` to the path above and apply `coding-agents-index.patch` in the docs repository.
2. Run that repository's formatting, content, and build checks. This workspace can check MDX syntax but cannot validate Cloudflare's full site build.
3. Review the [completed production verification](production.md), and rerun the live smoke test if the implementation changes. The deterministic model test and live Cloudflare checks are recorded separately.

The page uses the existing MDX frontmatter and admonition conventions. `sidebar.order: 4.5` places Hermes after Pi and before the vendor-managed agents. It deliberately omits a `reviewed` date until editorial review.
