# flow-n8n-harness

Kit de n8n para Claude Code. Duas coisas, e só elas:

| Comando | O que faz |
|---|---|
| `/ligar-n8n` | Liga esta máquina ao harness n8n por **OAuth**, sem token estático |
| `/esteira-n8n` | Roda o ciclo de um workflow: criar → testar → evidenciar → publicar com OK |

A esteira grava **evidência de cada passo** em `docs/evidencias/` do projeto que a usa: payload
enviado, resposta do webhook, JSON do workflow como o n8n o normalizou, a execução com o dado
que passou por cada nó, print do canvas e da lista de execuções, e um `INDICE.md` que amarra
tudo em ordem com o que passou e o que falhou.

## Instalar

Precisa de **Node 20+**, uma instância n8n com chave de API e, só para os prints, o Playwright.

### No seu projeto, a partir do GitHub

```bash
claude plugin marketplace add flowgrammers/flow-n8n
claude plugin install flow-n8n@flow-n8n
```

Os dois comandos passam a existir em **qualquer**
projeto, e o código do kit fica no cache do Claude Code. O seu projeto contribui com três
coisas, e só elas:

| No seu projeto | Para quê |
|---|---|
| `.env` | `N8N_API_URL` e `N8N_API_KEY`. Sem padrão: faltando, a esteira recusa rodar (saída 4) |
| `.secrets/n8n-sessao.json` | a sessão do editor, criada pelo `login`. Fora do Git, permissão 600 |
| `docs/evidencias/` | onde cada rodada grava payload, execução, prints e índice |

O passo 0 do `/esteira-n8n` prepara isso sozinho: põe `.secrets/` e `.env` no `.gitignore` e
cria a pasta de evidência. Ele **não** escreve `.env` nenhum, só diz quais variáveis preencher.
Direto na linha de comando, o mesmo passo é:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/lib/esteira.js" init
```

Para ter print de tela, instale o Playwright **no projeto**:

```bash
npm install --save-dev playwright && npx playwright install chromium
```

Sem ele o ciclo roda igual: só o passo de print sai como aviso no índice. O kit procura o
Playwright nele mesmo, depois no projeto, por fim na instalação global.

### Para mexer no kit

```bash
git clone https://github.com/flowgrammers/flow-n8n.git
cd flow-n8n
npm install
npx playwright install chromium
npm run teste:tudo
```

Rodando a partir da pasta clonada, os comandos são `npm run init · preparar · login · ciclo`
(veja [O ciclo](#o-ciclo)), e a evidência cai na própria pasta do kit.

### Fora do Claude Code

A esteira é Node puro e não depende do Claude Code, mas o empacotamento para Cursor, Codex e
`npx` ainda não está feito. Está descrito em [`docs/melhorias.md`](docs/melhorias.md) (M-01),
com o que falta.

### Desinstalar

```bash
claude plugin uninstall flow-n8n
claude plugin marketplace remove flow-n8n
```

O que ficou no seu projeto (`.env`, `.secrets/`, `docs/evidencias/`) não é tocado: a evidência
é sua, e some só se você apagar.

## Configurar

`.env` (não versionado) pede duas variáveis, e **nenhuma tem padrão**:

```
N8N_API_URL=https://sua-instancia.exemplo    # sem /api/v1
N8N_API_KEY=...                              # n8n → Settings → n8n API
```

Instância padrão embutida num kit de esteira cria workflow de teste no lugar errado, e o
estrago só aparece depois. Por isso a esteira recusa rodar sem `N8N_API_URL` — sai com 4.

## O ciclo

No Claude Code, o caminho normal é `/esteira-n8n`, que conduz os passos abaixo e para sozinho
antes de publicar. Na linha de comando, aponte `E` para a esteira — dentro do clone é um
caminho relativo; instalado como plugin, é `"$CLAUDE_PLUGIN_ROOT/scripts/lib/esteira.js"`:

```bash
E=plugins/flow-n8n/scripts/lib/esteira.js

node $E init        # prepara o PROJETO: .gitignore e docs/evidencias/
node $E preparar    # confere credencial e alcance
node $E login       # você loga; a sessão fica em .secrets/
node $E ciclo --spec plugins/flow-n8n/exemplos/eco.json
node $E publicar --id <workflow> --ok
node $E prints --id <workflow>     # prints de um workflow já criado
```

Passo a passo do `ciclo`:

1. **Sonda** a instância com a credencial, sem escrever nada.
2. **Cria** o workflow — inativo, como o n8n cria tudo.
3. **Lê** o workflow de volta, para ter o JSON canônico.
4. **Ativa temporariamente.** O webhook de produção só responde com o workflow ativo; a
   esteira desativa no fim, inclusive se o disparo falhar.
5. **Dispara** o webhook com o payload e guarda os dois lados da conversa.
6. **Lê a execução** no n8n, com `includeData`, para ter o dado de cada nó.
7. **Desativa.**
8. **Tira os prints** com a sessão que você autorizou.
9. **Escreve o índice.**

Workflow sem nó de webhook não é disparável pela API pública do n8n — ela não tem endpoint de
execução. A esteira registra o passo como pulado e manda disparar pela ferramenta
`test_workflow` do MCP.

## As três travas

**Publicar exige OK.** `publicar` sem `--ok` não ativa nada: imprime o que faria e sai com 3.
O OK é por workflow e por publicação — não vale para a próxima.

**A IA não digita senha.** O print precisa de sessão do editor. `esteira login` abre a janela
na tela de login do n8n e espera: quem digita é a pessoa. O script guarda só o cookie, em
`.secrets/` (no `.gitignore`), com permissão 600. Sessão expirada é detectada e falha com
instrução — em vez de salvar um print da tela de login.

**A evidência nasce publicável.** Tudo que vai para disco passa por redação: chave com nome de
segredo (`authorization`, `token`, `senha`, `apiKey`…) vira `«redigido»`, e qualquer string que
contenha a chave da API também. Há teste provando que a chave não chega ao arquivo.

## Códigos de saída

| Código | Significado |
|---|---|
| 0 | Tudo passou |
| 2 | Erro de uso |
| 3 | Falta o OK humano |
| 4 | Ambiente incompleto (ou Playwright ausente) |
| 5 | Algum passo falhou |

## Testes

```bash
npm run teste         # 19 asserções, sem rede e sem navegador
npm run teste:ciclo   # 11 asserções: o ciclo inteiro contra uma instância n8n falsa
npm run teste:plugin  # 6 asserções: o kit rodando DE FORA do projeto, como plugin instalado
npm run teste:prints  # sobe o Chromium e grava um PNG
npm run teste:tudo
```

`teste` cobre redação de segredo, numeração e índice da evidência, carregamento do `.env`,
leitura de webhook e os códigos de saída, incluindo o portão do `--ok`.

`teste:plugin` roda a esteira com o `cwd` num projeto temporário e o script fora dele — o
cenário do plugin instalado, onde o código vive no cache do Claude Code. Prova que o `init`
mexe no projeto e não no kit, que a evidência cai no projeto, que o exemplo viaja dentro do
plugin e que um projeto sem `.env` é **recusado** em vez de cair na configuração do kit.

`teste:ciclo` sobe um n8n de mentira em `testes/instancia-falsa.js` e roda a esteira de ponta a
ponta contra ele: exige o header da chave e **recusa o webhook de produção com o workflow
inativo**, como o n8n de verdade — é isso que prova que a ativação temporária do ciclo faz
trabalho real. Depois audita a pasta de evidência arquivo por arquivo, confere que o workflow
terminou inativo e que `publicar` sem `--ok` não ativou nada.
