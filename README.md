# Kreślak – gra w rysowanie i zgadywanie (jak skribbl.io)

Jedna osoba rysuje, reszta zgaduje hasło. Punkty za szybkość, rundy, podpowiedzi liter,
czat, prywatne pokoje z kodem/linkiem oraz gra publiczna.

## Wymagania hostingu
Gra jest w czasie rzeczywistym, więc potrzebny jest hosting z **Node.js (wersja 16+)**
i obsługą **WebSocketów** (VPS, Railway, Render, Fly.io, hosting z "Node.js App", itp.).
Zwykły hosting tylko z PHP/HTML NIE zadziała.

## Instalacja (VPS / SSH)
    npm install
    npm start                 # domyślnie port 3000 (zmienna PORT zmienia port)

Żeby działało po zamknięciu terminala:
    npm i -g pm2 && pm2 start server.js --name kreslak && pm2 save

## cPanel / "Setup Node.js App"
1. Wgraj wszystkie pliki (bez node_modules) do katalogu aplikacji.
2. Application startup file: `server.js`, kliknij "Run NPM Install", potem "Restart".

## HTTPS / własna domena (nginx)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

## Jak gracze dołączają
- **Utwórz prywatny pokój** → dostajesz 5-literowy kod i przycisk "Skopiuj link zaproszenia"
  (np. https://twojadomena.pl/#ABCDE). Znajomi otwierają link, wpisują nick i klikają
  "Dołącz do pokoju". Gospodarz ustawia rundy, czas i własne hasła, po czym startuje grę.
- **Graj publicznie** → trafiasz do otwartego pokoju; gra rusza sama 10 s po tym, jak są 2 osoby.

## Dostosowanie
- Hasła: `words.js`
- Wygląd i teksty: `public/index.html`
- Limit graczy: `MAX_PLAYERS` w `server.js` (domyślnie 12)
