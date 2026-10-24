# dsh-tool-cleversee

DSH plugin that adds two optional, model-invoked tools backed by Alibaba Cloud CleverSee:

- web_search_CleverSee_deep searches web pages and returns normalized source metadata and available excerpts.
- web_search_CleverSee_image searches for images and returns image URLs with source-page metadata.

The plugin does not replace DSH's default web_search provider. The tools are added only when the plugin is installed and its Cordis patch is applied.

## Requirements

- DSH with the @deepseek-ai/dsh-tools, @deepseek-ai/dsh-web, and related peer packages available.
- Node.js 20 or newer.
- A CleverSee API key, provided through the DSH credential store or the CLEVERSEE_API_KEY environment variable.

Do not commit API keys or place them in a public patch file. If request recording is enabled, search queries and request bodies may be written to DSH's plugin-records directory; disable it with recordRequests: false when queries should not be retained.

## Install

See INSTALL.md for general profile installation steps and INSTALL.patch.yml for the opt-in Cordis patch.

The patch adds only the two tools and leaves the default web_search route unchanged. Restart DSH after installing or changing the patch.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| apiKeyEnv | CLEVERSEE_API_KEY | Credential reference or environment variable name |
| textEngineType | CNLiteBasic | Default text-search engine |
| imageEngineType | MultimodalSpeed | Default image-search engine |
| numResults | 8 | Results requested per text query |
| imageMaxResults | 10 | Maximum merged image results |
| maxQueries | 4 | Maximum queries in one tool call |
| maxSources | 20 | Maximum merged text sources |
| maxCharsPerSource | 1200 | Maximum excerpt length |
| timeoutMs | 20000 | Request timeout |
| enableTextTool / enableImageTool | true | Enable either tool independently |
| alsoRegisterProvider | false | Optionally expose text search as a ctx.web provider |

Live calls can incur provider charges. Engine and billing behavior are controlled by the provider account and selected options.

## Test

npm test runs offline fixture and request-recording tests. It does not call either provider endpoint.

Live tests are separate and may incur charges:

    $env:CLEVERSEE_API_KEY = "your-key"
    npm run test:live

The live test reads the key from the environment and does not print it. Do not run it in automated public builds.

## License and source

This project declares the MIT license; see LICENSE. The plugin uses DSH peer packages and Alibaba Cloud's public API contract at runtime; those external services and packages are not included here.