#!/bin/bash
set -e

echo "🚀 [Doris Render] Starting instant health listener on port ${PORT:-10000}..."
java /app/RenderHealth.java &
HEALTH_PID=$!

echo "🔧 [Doris Render] Configuring Doris FE network & memory..."
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

echo "🐬 [Doris Render] Launching Apache Doris FE on MySQL port 9030..."
exec /opt/apache-doris/fe/bin/start_fe.sh --console
