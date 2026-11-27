// Runs INSIDE the agent's network namespace (only loopback; see egress.mjs). Listens on
// 127.0.0.1:<port> and relays every connection, byte for byte, to the allow-list proxy's UNIX
// socket outside the namespace — the agent's ONLY way out, and that proxy only tunnels to the npm
// registry. This process is also what keeps the namespace alive: if it dies, the lock reports
// inactive and no agent command runs until it is restarted.
import net from "node:net";

const [sock, port] = [process.argv[2], Number(process.argv[3] || 3128)];
const server = net.createServer((client) => {
  const upstream = net.connect(sock);
  client.pipe(upstream); upstream.pipe(client);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
server.on("error", (e) => { console.error(String(e.message)); process.exit(1); });
server.listen(port, "127.0.0.1", () => process.stdout.write("ready\n"));
