import { readFileSync } from "node:fs";
import path from "node:path";

export const PROXY_FILE = "agy-pool-proxy";

export const NO_PROXY = "localhost,127.0.0.1,::1,100.64.0.0/10,.ts.net";

const SCHEMES: Readonly<Record<string, string>> = { "http:": "80", "https:": "443", "socks5:": "1080" };

export type ProxyRoute = { readonly kind: "proxy"; readonly url: string; readonly endpoint: string };

export type Route = { readonly kind: "direct" } | ProxyRoute;

export type Unusable = { readonly kind: "invalid"; readonly problem: string };

export type Egress = Route | Unusable;

const invalid = (problem: string): Unusable => ({ kind: "invalid", problem });

export function parseProxyUrl(text: string): ProxyRoute | Unusable {
  const raw = text.trim();
  if (raw === "" || /\s/.test(raw)) return invalid("must hold exactly one proxy URL on one line");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("is not a URL");
  }
  const defaultPort = SCHEMES[url.protocol];
  if (defaultPort === undefined) return invalid(`uses ${url.protocol} (expected http, https or socks5)`);
  if (url.hostname === "") return invalid("has no host");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return invalid("must not carry a path or query");
  return { kind: "proxy", url: raw, endpoint: `${url.hostname}:${url.port || defaultPort}` };
}

export function readEgress(accountDir: string): Egress {
  const file = path.join(accountDir, PROXY_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "direct" };
    return invalid(`${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? error})`);
  }
  const route = parseProxyUrl(text);
  return route.kind === "invalid" ? invalid(`${file} ${route.problem}`) : route;
}

export function routeEnv(route: Route): Readonly<Record<string, string>> {
  if (route.kind === "direct") return {};
  return { HTTPS_PROXY: route.url, HTTP_PROXY: route.url, NO_PROXY };
}
