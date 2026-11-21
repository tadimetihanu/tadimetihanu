#!/bin/bash
set -e

# Find Java binary
if [ -n "$JAVA_HOME" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    JAVA_BIN="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
    JAVA_BIN="java"
else
    JAVA_BIN=$(find /usr/lib/jvm -name java -type f 2>/dev/null | head -n 1)
fi

echo "🚀 [Doris Render] Using Java binary: $JAVA_BIN"

# Start instant health responder on PORT (default 10000)
cd /app
if [ -n "$JAVA_BIN" ]; then
    if [ -f /app/RenderHealth.class ]; then
        $JAVA_BIN -cp /app RenderHealth &
    elif [ -f /app/RenderHealth.java ]; then
        $JAVA_BIN /app/RenderHealth.java &
    fi
    echo "✅ [Doris Render] Health listener started on port ${PORT:-10000}"
fi

# Configure fe.conf
FE_CONF="/opt/apache-doris/fe/conf/fe.conf"
if [ -f "$FE_CONF" ]; then
    sed -i 's/-Xmx[0-9]*[mgMG]/-Xmx384m/g' "$FE_CONF" 2>/dev/null || true
    sed -i 's/-Xms[0-9]*[mgMG]/-Xms192m/g' "$FE_CONF" 2>/dev/null || true
    
    grep -q "priority_networks" "$FE_CONF" || echo "priority_networks = 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10" >> "$FE_CONF"
    grep -q "enable_fqdn_mode" "$FE_CONF" || echo "enable_fqdn_mode = true" >> "$FE_CONF"
    grep -q "sys_log_to_console" "$FE_CONF" || echo "sys_log_to_console = true" >> "$FE_CONF"
fi

export JAVA_OPTS="-Xmx384m -Xms192m -XX:+UseG1GC"
export FE_SERVICENAME="doris-fe"
export ENABLE_FQDN_MODE="true"

echo "🐬 [Doris Render] Starting Apache Doris FE..."
exec /opt/apache-doris/fe/bin/start_fe.sh --console
