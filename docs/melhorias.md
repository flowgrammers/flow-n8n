# Melhorias conhecidas

O que falta, com o porquê. Nada aqui está começado pela metade.

## M-01 · Rodar fora do Claude Code (Cursor, Codex, npx)

O CLI (`plugins/flow-n8n/scripts/lib/esteira.js`) é Node puro e não depende do Claude Code, então
pode ser a superfície universal do kit. Para isso faltam três coisas:

1. `bin` no `package.json` apontando para o `esteira.js`, de modo que
   `npx github:flowgrammers/flow-n8n preparar` funcione sem clonar.
2. Um `AGENTS.md` na raiz com o mesmo contrato do comando `/esteira-n8n` — é o arquivo que Codex e
   Cursor leem. O comando do Claude Code passaria a ser uma casca sobre ele, para não existirem duas
   fontes da verdade.
3. O `npx playwright install chromium` documentado por ferramenta, já que fora do kit o Playwright
   vem do projeto.

**O que já está feito nessa direção**: o exemplo viaja dentro do plugin
(`plugins/flow-n8n/exemplos/eco.json`), o Playwright é procurado também a partir do projeto que usa
o kit, e existe `esteira init` para preparar um projeto novo. Instalado como plugin do Claude Code,
o kit já funciona em qualquer projeto — provado por `npm run teste:plugin`, que roda a esteira com o
`cwd` num projeto e o script fora dele.

## M-02 · Disparar workflow sem webhook

A API pública do n8n não executa workflow: não existe `POST /workflows/{id}/run`. Quem dispara é o
gatilho. Hoje a esteira cobre webhook; workflow de agenda ou de gatilho de serviço fica com o passo
de teste marcado como pulado, e a orientação é disparar pela ferramenta `test_workflow` do MCP e
juntar o JSON da execução à pasta da rodada. Automatizar essa ponte é trabalho em aberto.
