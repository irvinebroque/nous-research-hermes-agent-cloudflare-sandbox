# Publishing the Cloudflare docs page

`hermes.mdx` is a self-contained how-to for:

```text
src/content/docs/sandbox/coding-agents/hermes.mdx
```

in [cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs). Its public URL will be `https://developers.cloudflare.com/sandbox/coding-agents/hermes/`.

The existing `/sandbox/coding-agents/` URL is the overview. `coding-agents-index.patch` adds a Hermes card there and adjusts the introduction so it accommodates this standalone example. It does not replace the overview.

The draft embeds the runnable source, so no unpublished example-repository URL is required. Once this repository has a public URL, add an example-repository link to the page's related resources. No Git remote is configured in this workspace yet.

Before publishing:

1. Copy `hermes.mdx` to the path above and apply `coding-agents-index.patch` in the docs repository.
2. Run that repository's formatting, content, and build checks. This workspace can check MDX syntax but cannot validate Cloudflare's full site build.
3. Complete the live deployment/model smoke check described in the repository README. Do not describe the stubbed model test as a live Cloudflare success.

The page uses the existing MDX frontmatter and `WranglerConfig` component conventions. `sidebar.order: 4.5` places Hermes after Pi and before the vendor-managed agents. It deliberately omits a `reviewed` date until editorial review.
