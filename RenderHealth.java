import com.sun.net.httpserver.*;
import java.net.InetSocketAddress;
import java.io.OutputStream;

public class RenderHealth {
    public static void main(String[] args) {
        try {
            int port = 10000;
            String envPort = System.getenv("PORT");
            if (envPort != null && !envPort.isEmpty()) {
                try {
                    int parsed = Integer.parseInt(envPort.trim());
                    // Never hijack Doris MySQL query_port (9030)
                    if (parsed != 9030) {
                        port = parsed;
                    }
                } catch (Exception ignored) {}
            }
            HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
            server.createContext("/", exchange -> {
                if ("HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
                    exchange.sendResponseHeaders(200, -1);
                    exchange.close();
                    return;
                }
                byte[] response = "Doris FE Active on Render\n".getBytes();
                exchange.sendResponseHeaders(200, response.length);
                OutputStream os = exchange.getResponseBody();
                os.write(response);
                os.close();
            });
            server.setExecutor(null);
            server.start();
            System.out.println("✅ [Render Health Server] Instant listener bound to 0.0.0.0:" + port);
        } catch (Exception e) {
            System.err.println("Health server notice: " + e.getMessage());
        }
    }
}
