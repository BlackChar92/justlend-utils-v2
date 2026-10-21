import { createRequire } from "node:module";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Resolve the HTTP stack actually used by the installed TronWeb dependency.
const tronwebRequire = createRequire(require.resolve("tronweb"));
const axiosRequire = createRequire(tronwebRequire.resolve("axios"));
const redirects = axiosRequire("follow-redirects");
const servers = [];

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function getHeaders(url, options) {
  return new Promise((resolve, reject) => {
    const request = redirects.http.get(url, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("Loopback fixture timed out")));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe("redirect credential boundaries", () => {
  // Loopback fixtures and inert markers only; no product APIs or real credentials.
  async function crossOrigin(options) {
    const initial = [];
    const target = await listen((request, response) => {
      response.end(JSON.stringify(request.headers));
    });
    const source = await listen((request, response) => {
      initial.push(request.headers);
      response.writeHead(302, { location: `${target}/received` });
      response.end();
    });
    // Node does not auto-add Host when raw array-form headers are supplied.
    if (Array.isArray(options.headers)) {
      options = { ...options, headers: ["Host", new URL(source).host, ...options.headers] };
    }
    return { initial, forwarded: await getHeaders(`${source}/start`, options) };
  }

  it("strips built-in credentials from object-form headers across origins", async () => {
    const { initial, forwarded } = await crossOrigin({ headers: {
      Authorization: "offline-auth-marker", Cookie: "offline-cookie-marker",
      "Proxy-Authorization": "offline-proxy-marker", "X-Keep": "visible",
    } });
    expect(initial[0].authorization).toBe("offline-auth-marker");
    for (const key of ["authorization", "cookie", "proxy-authorization"]) {
      expect(forwarded).not.toHaveProperty(key);
    }
    expect(forwarded["x-keep"]).toBe("visible");
  });

  // GHSA-q3jh-wrc6-jgq8: raw header arrays must not bypass credential stripping.
  it("strips built-in credentials from array-form headers across origins", async () => {
    const { initial, forwarded } = await crossOrigin({ headers: [
      "Authorization", "offline-auth-marker", "Cookie", "offline-cookie-marker",
      "Proxy-Authorization", "offline-proxy-marker", "X-Keep", "visible",
    ] });
    expect(initial[0].authorization).toBe("offline-auth-marker");
    for (const key of ["authorization", "cookie", "proxy-authorization"]) {
      expect(forwarded).not.toHaveProperty(key);
    }
    expect(forwarded["x-keep"]).toBe("visible");
  });

  // GHSA-8r9p-f939-6h3c: valid header-name metacharacters must be escaped.
  it.each(["X-Api^Key", "X-Token|Secret"])("strips declared sensitive header %s", async (name) => {
    const { initial, forwarded } = await crossOrigin({
      headers: { [name]: "offline-custom-marker", "X-Keep": "visible" },
      sensitiveHeaders: [name],
    });
    expect(initial[0][name.toLowerCase()]).toBe("offline-custom-marker");
    expect(forwarded).not.toHaveProperty(name.toLowerCase());
    expect(forwarded["x-keep"]).toBe("visible");
  });

  it("preserves credentials for a same-origin relative redirect", async () => {
    const source = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/received" });
        response.end();
      } else {
        response.end(JSON.stringify(request.headers));
      }
    });
    const forwarded = await getHeaders(`${source}/start`, { headers: {
      Authorization: "offline-auth-marker", Cookie: "offline-cookie-marker",
    } });
    expect(forwarded.authorization).toBe("offline-auth-marker");
    expect(forwarded.cookie).toBe("offline-cookie-marker");
  });
  it("preserves TronWeb provider GET and JSON POST behavior", async () => {
    const source = await listen((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          method: request.method, path: request.url, body,
          marker: request.headers["x-offline-marker"],
        }));
      });
    });
    const { HttpProvider } = require("tronweb").providers;
    const provider = new HttpProvider(source, 2_000, "", "", {
      "X-Offline-Marker": "provider-fixture",
    });
    const query = await provider.request("/offline-query", { value: "a b" });
    const url = new URL(query.path, source);
    expect(query.method).toBe("GET");
    expect(url.pathname).toBe("/offline-query");
    expect(url.searchParams.get("value")).toBe("a b");
    expect(query.marker).toBe("provider-fixture");
    const post = await provider.request("/offline-post", { amount: "123" }, "post");
    expect(post.method).toBe("POST");
    expect(post.path).toBe("/offline-post");
    expect(JSON.parse(post.body)).toEqual({ amount: "123" });
    expect(post.marker).toBe("provider-fixture");
  });

});
