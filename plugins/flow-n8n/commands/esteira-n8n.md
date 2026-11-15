---
description: Roda o ciclo completo de um workflow n8n — criar, testar, evidenciar com print e payload, e publicar só com OK da pessoa
allowed-tools: Bash(node:*), Bash(npm:*)
---

A esteira mora em `${CLAUDE_PLUGIN_ROOT}/scripts/lib/esteira.js`. Ela grava evidência de cada
passo em `docs/evidencias/<rodada>/` do projeto onde você está, e termina num `INDICE.md`.

Trabalhe nesta ordem e **pare onde o texto manda parar**.

## 0. Preparar o projeto, na primeira vez

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/esteira.js" init
```

Põe `.secrets/` e `.env` no `.gitignore` do projeto e cria `docs/evidencias/`. Não escreve
`.env` nenhum: diz quais variáveis a pessoa precisa preencher.

## 1. Conferir o ambiente

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/esteira.js" preparar
```

- Saída **4** é ambiente incompleto: falta `N8N_API_URL` ou `N8N_API_KEY`. Diga à pessoa para
  copiar `.env.example` para `.env` e preencher; a chave sai em *n8n → Settings → n8n API*.
  Você não pede a chave no chat e não a escreve em arquivo nenhum.
- Saída **5** é instância recusando a credencial. Repasse a mensagem e pare.
- Se o relatório disser que **falta login**, o print de tela vai faltar. Avise, e ofereça o
  passo 2 — não tente contornar.

## 2. Sessão do editor, quando a pessoa quiser print

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/esteira.js" login
```

Abre uma janela do navegador na tela de login do n8n. **Quem digita é a pessoa.** Você não
preenche campo, não pede senha no chat e não aceita senha colada aqui. O script guarda apenas
o cookie de sessão, em `.secrets/` — que está no `.gitignore`.

## 3. O ciclo

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/esteira.js" ciclo --spec <arquivo.json> --payload <arquivo.json>
```

Um exemplo testável ponta a ponta viaja com o plugin, em
`${CLAUDE_PLUGIN_ROOT}/exemplos/eco.json`. O `--spec` é a definição do workflow; o `--payload` é o corpo que o teste manda ao webhook
(sem ele, a esteira usa um payload mínimo de teste). O ciclo faz, em ordem: sonda a instância,
cria o workflow **inativo**, lê o JSON como o n8n o normalizou, ativa **temporariamente**,
dispara o webhook, lê a execução com o dado que passou por cada nó, desativa, tira os prints e
escreve o índice.

Ao terminar, leia o `INDICE.md` e relate à pessoa: o id do workflow, o status de cada passo e o
caminho da pasta de evidência. Passo com `falhou` é para consertar antes de seguir — a esteira
sai com **5** quando algo falhou.

Workflow sem nó de webhook não é disparável pela API pública do n8n (ela não tem endpoint de
execução). Nesse caso a esteira registra o passo como pulado: dispare pela ferramenta
`test_workflow` do MCP e junte o JSON da execução à pasta da rodada.

## 4. Publicar — e aqui você para

Publicar **ativa** o workflow na instância. Isso nunca sai de você: pergunte à pessoa, com o id
do workflow e o nome da instância na frente, e espere um sim explícito. Só então:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/esteira.js" publicar --id <workflow> --ok
```

Sem `--ok` o comando não ativa nada — imprime o que faria e sai com **3**. Não passe `--ok`
por iniciativa própria, nem porque o ciclo passou, nem porque a pessoa autorizou um workflow
anterior: o OK é por workflow e por publicação.

`limpar --id <workflow> --ok` apaga o workflow de teste, e segue a mesma regra do OK.
