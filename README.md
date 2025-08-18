# Stock Alerts Daemon

Servicio en Node.js que escucha **precios intradía** (Finnhub WebSocket) y envía **alertas** a un **Webhook de n8n** (de ahí a Telegram). Incluye **modo simulador** para pruebas fuera de horario y fines de semana.

## Características
- Ventana deslizante (10 min por defecto) para calcular **Δ%**.
- Reglas: **swing** (Δ%), **breakout** (HOD/LOD) y **momentum**.
- **Cooldown** por símbolo + deduplicación (+0.5% desde la última alerta).
- Conmutación **TEST/PROD** a n8n por variable de entorno.
- **Simulador** de ticks (1/s) con picos aleatorios 2–5% para pruebas.

## Requisitos
- Node.js 18+ en WSL (Ubuntu recomendado).
- Cuenta Finnhub (token **free** suficiente para pruebas).
- Workflow en n8n con **Webhook** (TEST y/o PROD) y salida a Telegram.

## Instalación
```bash
git clone https://github.com/<tu-usuario>/stocks-alerts.git
cd stocks-alerts
npm install
```
### Modo simulación (recomendado para pruebas)
Genera ticks sintéticos y dispara alertas sin depender del mercado:
```bash
SIM_MODE=1 IGNORE_MARKET_HOURS=1 N8N_ENV=TEST node src/index.js
```

### Modo Fiinnhub (TEST)
```bash
N8N_ENV=TEST SIM_MODE=0 node src/index.js
```

Producción (Finnhub + Webhook PROD)
1. Activa el workflow en n8n (Production URL).
2. Lanza el servicio:
```bash
N8N_ENV=PROD SIM_MODE=0 node src/index.js
```
Si ves Finnhub WS connected → AAPL, TSLA, ... quedó enlazado. Las alertas llegarán al flujo de n8n.

Arranque automático como servicio
Opción A — PM2 
```bash
npm i -g pm2
pm2 start src/index.js --name stock-alerts --env production
pm2 save
pm2 startup    # instrucción para que arranque con WSL/systemd
```

Logs:
```bash
pm2 logs stock-alerts
```