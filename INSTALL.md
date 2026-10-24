# Installation

This plugin is opt-in and does not change the default DSH web_search provider.

1. Use Node.js 20 or newer and make the package available to the DSH desktop profile. With a local checkout, use the supported plugin manager if available:

       dsh plugin --profile desktop add <absolute-path-to-dsh-tool-cleversee>

   Alternatively, copy the package directory into the desktop profile's node_modules directory.

2. Add the contents of INSTALL.patch.yml to the desktop profile's cordis.patch.yml. The patch registers the tools with no literal API key and does not select a new default search provider.

3. Provide CLEVERSEE_API_KEY through the DSH credential store or the process environment used to launch DSH.

4. Restart DSH and invoke either tool explicitly.

To remove the integration, remove its Cordis patch entry and uninstall the plugin from the desktop profile. This does not alter other search-provider settings.