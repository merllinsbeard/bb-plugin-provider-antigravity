import { definePluginApp } from "@get-bb/plugin-sdk/app";

// bb's usage card separates providers only, so two accounts of one provider
// would run together without this line.
const ACCOUNT_DIVIDER_CSS = `
[role="tabpanel"][aria-label*="usage"] section[aria-label] + section[aria-label] {
  border-top: 1px dashed var(--sidebar-border);
  padding-top: 0.625rem;
}
`;

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "usage-account-divider",
    mount() {
      const style = document.createElement("style");
      style.textContent = ACCOUNT_DIVIDER_CSS;
      document.head.append(style);
      return () => style.remove();
    },
  });
});
