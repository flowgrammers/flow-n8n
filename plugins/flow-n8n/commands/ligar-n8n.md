---
description: Liga este Claude Code ao harness n8n por OAuth, sem token estático (uma vez por máquina)
allowed-tools: Bash(node:*)
---

Rode, com a ferramenta Bash e a partir do diretório do projeto, o comando abaixo. Ele só diagnostica e imprime: não
escreve na configuração, não renova token e não pede nada.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ligar-n8n.js" plano --cwd "$PWD"
```

Leia a saída e repasse à pessoa o que ela diz, nesta ordem:

1. **Se houver `Authorization` fixo no arquivo**, é ele o problema — e o conserto é tirá-lo, não renová-lo. Um Bearer
   escrito à mão no `~/.claude.json` desliga o fallback de OAuth do Claude Code: o cliente manda o token fixo, o
   servidor devolve 401, e a sessão fica sem nenhuma ferramenta do n8n. Mostre os comandos impressos num bloco de
   código e diga para colá-los num terminal **fora desta conversa**.
2. **Se a sondagem disser que o OAuth não está oferecido** (saída 4), não mande tirar o header: sem OAuth, remover a
   única autenticação deixa o harness inacessível. Aí falta um token novo, e quem emite é o Lucas ou o Ric.
3. **Depois dos comandos**, a autorização é no `/mcp`, dentro do Claude Code, feita pela pessoa.

Você não roda os comandos impressos, não executa o fluxo de OAuth e não aceita token, senha ou código colado aqui. A
sondagem do script sai de propósito sem credencial — é ela que prova que há OAuth antes de recomendar remover a
autenticação atual. Se o harness recusar por falta de acesso, quem libera é o Lucas ou o Ric.
