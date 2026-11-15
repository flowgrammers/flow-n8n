# CLAUDE.md — flow-n8n-harness

flowos-mode: bazuca

## O que é

Kit de n8n para Claude Code, com duas entregas: a **ligação** por OAuth (`/ligar-n8n`) e a
**esteira** de workflow com evidência (`/esteira-n8n`). Nasceu apartado do `flow-os` de
propósito — aqui só entra coisa de n8n.

## Estrutura

```
.claude-plugin/marketplace.json      # marketplace local, para instalar com claude plugin
plugins/flow-n8n/
  .claude-plugin/plugin.json
  commands/ligar-n8n.md              # diagnóstico da ligação por OAuth
  commands/esteira-n8n.md            # o ciclo, passo a passo, com o portão do OK
  scripts/lib/ligar-n8n.js           # constata o header estático e manda tirá-lo
  scripts/lib/n8n.js                 # cliente da REST API pública
  scripts/lib/evidencia.js           # pasta da rodada, redação de segredo, índice
  scripts/lib/prints.js              # Playwright: login humano e captura
  scripts/lib/esteira.js             # a CLI do ciclo
plugins/flow-n8n/exemplos/eco.json   # workflow de webhook que a esteira testa ponta a ponta
testes/executar.js                   # suíte sem rede
```

## Comandos

```bash
npm install && npx playwright install chromium
npm run teste          # 15 asserções, sem rede
npm run preparar       # confere credencial e alcance
npm run login          # a PESSOA loga; sessão em .secrets/
npm run ciclo -- --spec exemplos/eco.json
```

## Invariantes — o que o código impõe

1. **Nenhuma instância embutida.** `N8N_API_URL` é obrigatória e sem padrão.
2. **Publicar exige `--ok`.** Sem ele, sai 3 e não ativa nada. O OK é por publicação.
3. **Teste não é publicação.** O ciclo ativa para disparar o webhook e **desativa no `finally`**.
4. **A IA não digita senha.** Login é passo humano; o script guarda só o cookie de sessão.
5. **Passo sem arquivo não existe.** Cada etapa grava em `docs/evidencias/<rodada>/`.
6. **Segredo não vai para a evidência.** `redigir()` corta por nome de chave e por valor.

## Armadilhas já pagas

- **A API pública do n8n não executa workflow.** Não existe `POST /workflows/{id}/run`. Quem
  dispara é o gatilho — webhook, agenda — ou a ferramenta `test_workflow` do MCP.
- **`Authorization` fixo no `~/.claude.json` desliga o OAuth do Claude Code.** O cliente manda
  o Bearer vencido, o servidor devolve 401 e a sessão perde todas as ferramentas do n8n, com
  cara de falta de escopo. É o que o `ligar-n8n.js` diagnostica — e o conserto é **tirar** o
  header, não renová-lo.
- **O POST de criação recusa campos de leitura** (`id`, `active`, `tags`, `createdAt`). O
  cliente filtra para os cinco que a API aceita.

## Convenções

- Código e identificador em ASCII; prosa, comentário e commit em pt-BR **com acento**.
- Commits em conventional commits.
