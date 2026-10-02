# RepoGuard-Nudge

Extensão do VS Code, artefato de um trabalho acadêmico de segurança, contra o golpe do falso recrutador: o atacante envia um "desafio técnico" cujo repositório executa código sozinho durante a preparação do ambiente (scripts de ciclo de vida do npm, tarefas de abertura do VS Code) e rouba chaves SSH, credenciais de nuvem e variáveis de ambiente.

## Princípio: contenção por padrão, liberação informada

- **Todo comando do repositório roda num container efêmero**, que enxerga só uma cópia do projeto. Nenhuma decisão do usuário é necessária para a proteção valer.
- **A análise estática não é a defesa principal.** Se ela falhar, o container segura. A função dela é **informar** o pedido de liberação: quando o desenvolvedor pede uma porta, uma pasta, uma variável ou a execução direta na máquina, o alerta mostra as evidências encontradas.
- **Abaixo do limiar, silêncio.** Alertar em todo repositório reintroduziria a habituação que torna inútil o diálogo "Você confia nos autores?".

## Pré-requisitos

| Para | Precisa de |
|---|---|
| Usar a extensão | VS Code 1.93 ou mais recente |
| Executar em sandbox | Docker Desktop (Windows/macOS), Docker Engine (Linux) ou Podman, **instalado e rodando** |
| Desenvolver e testar | Node.js 20 ou mais recente |

Sem Docker, a análise, o painel e o registro funcionam normalmente. Ao pedir para executar em sandbox, a extensão avisa que **nada foi executado** e por quê. Ela nunca passa a rodar o comando direto na sua máquina. Veja [Garantindo o Docker](#garantindo-o-docker).

## Desenvolvimento

```bash
npm install
npm run compile
npm test
```

O esperado é 123 testes aprovados e 2 pulados:
- o teste de link simbólico de arquivo, que exige privilégio no Windows;
- a integração com Docker real, que só roda com `REPOGUARD_DOCKER_IT=1`.

Para rodar também a integração com Docker real, que baixa `node:20-slim` (no PowerShell):

```powershell
$env:REPOGUARD_DOCKER_IT="1"; npm test
```

## Depuração (F5)

1. Abra esta pasta no VS Code e vá em **Run and Debug**.
2. Escolha um perfil, por exemplo **RepoGuard: adversarial-postinstall**, e aperte **F5**. O perfil compila, copia as fixtures para `../repoguard-fixtures` e abre a escolhida numa janela **[Extension Development Host]**.
3. Quando o VS Code perguntar se você confia nos autores, escolha **modo restrito**. É o cenário principal: a extensão tem que funcionar antes da confiança.
4. Acompanhe em **View > Output > "RepoGuard-Nudge"**: caminho do registro, arquivos lidos, pontuação e justificativa.
5. Pontos de interrupção em `src/**/*.ts` funcionam normalmente (mapas de código-fonte).

**Por que copiar as fixtures?** O VS Code faz subpastas herdarem a confiança da pasta-mãe. Abertas dentro deste projeto, que você já marcou como confiável, as fixtures nunca começariam em modo restrito. A cópia em `../repoguard-fixtures` é refeita a cada F5, o que também apaga os marcadores `CANARIO-*.txt` de testes anteriores.

### Roteiro de teste manual

| Teste | Como | Esperado |
|---|---|---|
| Silêncio | Perfil `benigno-simples` ou `benigno-com-build` | Nenhum painel. O Output mostra pontuação 0 ou 45 |
| Alerta | Perfil `adversarial-postinstall` | Painel abre sozinho: 6 evidências, nível ALTO, Base64 decodificado ao lado do original |
| Execução fora do container | Perfil `adversarial-tasks-json` | Painel com aviso "Não clique em Confiar" no topo |
| Inspecionar | Botão **Inspecionar código** ou o link "linha N" | Arquivo abre na linha, destacada |
| Sandbox | Botão **Executar em sandbox** → `npm install` | Com Docker: o marcador `CANARIO-POSTINSTALL-EXECUTADO.txt` aparece só na cópia isolada, **não** na pasta aberta. Sem Docker: aviso de que nada foi executado |
| Liberações | Paleta (Ctrl+Shift+P) → "RepoGuard: Solicitar liberação de…" | Um diálogo por liberação. O hospedeiro exige digitar o nome da pasta |
| Modo controle | Configurações de **usuário**: `repoguard.modo` = `controle` | Nada visível (nem painel, nem comandos, nem canal no Output). O registro continua |
| Configuração hostil | Na fixture, crie `.vscode/settings.json` com `"repoguard.modo": "controle"` | Ignorado: a extensão continua em modo experimental |

## Empacotar e instalar

```bash
npm run package
```

Gera `repoguard-nudge-0.1.0.vsix`. Para instalar:

```bash
code --install-extension repoguard-nudge-0.1.0.vsix
```

Ou, no VS Code: **Extensions > ⋯ > Install from VSIX…**

## Configurações

Todas têm `scope: application`: só valem nas configurações de **usuário**. Um repositório não consegue alterá-las pelo `.vscode/settings.json`, e a extensão ainda ignora valores do workspace como defesa em profundidade.

| Configuração | Padrão | Descrição |
|---|---|---|
| `repoguard.modo` | `experimental` | `experimental` ativa tudo; `controle` desliga toda a interface e mantém o registro |
| `repoguard.participanteId` | vazio | Identificador anônimo (vazio vira `nao-definido` no registro) |
| `repoguard.grupo` | vazio | Rótulo do grupo; se vazio, usa o modo |
| `repoguard.desafioId` | vazio | Identificador do desafio; se vazio, usa o nome da pasta aberta |
| `repoguard.caminhoRegistro` | vazio | Caminho **absoluto** do `.jsonl` (ou de uma pasta). Se vazio, usa o armazenamento global da extensão |
| `repoguard.imagemContainer` | `node:20-slim` | Imagem Docker do sandbox |
| `repoguard.comandoContainer` | `docker` | `docker` ou `podman` (alternativa gratuita, aceita os mesmos comandos) |

Os pesos do motor ficam em `config/weights.json` e podem ser recalibrados sem recompilar. Esse arquivo vem com a extensão, nunca do repositório analisado.

## Protocolo do experimento

### Preparação de cada máquina

1. Instale a extensão (`.vsix`).
2. Nas configurações de **usuário**, defina `repoguard.modo` (conforme o sorteio), `repoguard.participanteId`, `repoguard.desafioId` e `repoguard.caminhoRegistro`.
3. Grupo experimental: rode **RepoGuard: Verificar ambiente** (Ctrl+Shift+P). Ele confere o Docker/Podman, oferece baixar a imagem (assim o primeiro sandbox não espera download), testa se o arquivo de registro pode ser gravado e mostra o participante e o modo. No grupo controle, rode a verificação **antes** de trocar o modo para `controle`, porque nesse modo o comando fica escondido.
4. Confirme que o terminal integrado usa PowerShell, bash ou zsh. A captura de comandos do terminal depende da integração de shell do VS Code e **não funciona no cmd.exe**.
5. Ao fim, recolha o arquivo `.jsonl`.

### Formato do registro

Uma linha JSON por evento:

```json
{"participanteId":"P07","grupo":"experimental","desafioId":"desafio-2","evento":"painel_cancelado","timestamp":"2026-10-02T12:00:00.000Z","detalhes":{"via":"botao","tempoAbertoMs":4200,"evidenciasInspecionadas":1,"nivel":"ALTO","sessaoId":"…","seq":5}}
```

`detalhes.sessaoId` identifica a janela do VS Code. `detalhes.seq` preserva a ordem dos eventos mesmo com timestamps iguais.

| Evento | Detalhes principais |
|---|---|
| `workspace_aberto` | pasta, se já era confiável, modo |
| `analise_concluida` | pontuação, nível, nº de evidências, famílias, multiplicador, `acimaDoLimiar`, duração |
| `painel_exibido` | pontuação, nível, nº de evidências, famílias |
| `painel_cancelado` | `via` (`botao` ou `aba`), tempo com o painel aberto, evidências inspecionadas |
| `evidencia_inspecionada` | id, família, arquivo, linha |
| `sandbox_executado` | origem (`painel` ou `comando`), comando, código de saída, liberações ativas |
| `liberacao_solicitada` / `liberacao_concedida` / `liberacao_negada` | tipo; na negada, o motivo |
| `execucao_hospedeiro` | origem: `terminal`, `tarefa`, `depurador` ou `liberacao` |

`analise_concluida` com `acimaDoLimiar: true` no grupo controle indica onde o alerta **teria** aparecido. `execucao_hospedeiro` com origem `terminal` é a forma de saber se alguém rodou `npm install` direto na máquina, nos dois grupos.

**Privacidade:** o registro não sai da máquina. Valores de variáveis liberadas e caminhos de pastas locais não são registrados. Segredos que apareçam em comandos digitados (`API_KEY=…`, tokens do GitHub, do npm e da AWS, `Bearer …`, senhas em URLs) são mascarados como `<omitido>`. Ainda assim, os comandos digitados no terminal são registrados: informe isso no termo de consentimento.

## Garantindo o Docker

Uma extensão do VS Code **não consegue instalar o Docker**, e nem deveria tentar:
- a instalação exige privilégio de administrador e, no Windows, WSL 2 e reinicialização;
- o Docker Desktop tem licença própria (gratuito para uso educacional, pessoal e empresas pequenas).

O que a extensão faz e o que cabe a quem a distribui:

- **A extensão verifica antes de cada execução.** Distingue programa não instalado, instalado mas parado e sem resposta, e diz exatamente o que fazer. Ela nunca degrada silenciosamente para o hospedeiro.
- **O painel avisa antes do clique.** Se o Docker/Podman não estiver disponível, o painel de evidências mostra isso junto das ações, para o usuário não tentar o sandbox sem saber que vai falhar.
- **Comando "RepoGuard: Verificar ambiente".** Checklist da máquina: programa de containers, imagem baixada (com opção de baixar na hora), registro gravável, participante e modo.
- **Podman como alternativa.** Com `repoguard.comandoContainer` = `podman`, o sandbox usa o Podman, gratuito e sem daemon com privilégio de root. Útil se a licença do Docker Desktop for um problema na instituição.
- **No experimento, os pesquisadores preparam as máquinas** (seção acima). É a única forma de garantir que a variável estudada seja a interface, não a instalação de software.
- **Fora do experimento,** o Docker deve ser declarado como pré-requisito na página da extensão.

## Repositórios de teste (`test/fixtures`)

| Fixture | O que contém | Resultado esperado |
|---|---|---|
| `benigno-simples` | Servidor HTTP mínimo | 0, BAIXO, silêncio |
| `benigno-com-build` | `prepare` + `preLaunchTask` + build com `child_process` | 45, BAIXO, silêncio |
| `adversarial-tasks-json` | Tarefa `folderOpen` que "rouba" o ambiente | 127,5, ALTO, fora da contenção |
| `adversarial-postinstall` | `postinstall` que lê "chave SSH", destino em Base64, envio por rede | 200, ALTO (tríade) |

**As fixtures adversariais são canários inofensivos**, e um teste automatizado garante isso:
- toda URL, inclusive a escondida em Base64, usa o domínio `.invalid`, que por norma (RFC 6761) nunca resolve;
- nenhum script acessa a pasta pessoal; a "chave SSH" é um texto falso dentro da própria fixture;
- do ambiente, só o tamanho seria enviado.

Se executadas, elas apenas criam um arquivo `CANARIO-*.txt` na pasta em que rodaram. É assim que se verifica se o código rodou no container ou na máquina.

## Arquitetura

```
src/
├── extension.ts        ativação (onStartupFinished, suporte a modo restrito) e orquestração
├── config.ts           leitura de configurações só do usuário
├── workspaceReader.ts  leitura via vscode.workspace.fs
├── collector.ts        coleta de manifestos e scripts referenciados (só leitura)
├── analyzers/
│   ├── manifests.ts    package.json, tasks.json, launch.json, devcontainer, setup.py, pyproject, Makefile
│   ├── scripts.ts      JS/TS via Babel (AST) e shell via texto
│   └── common.ts       posições, trechos seguros, padrões compartilhados
├── engine.ts           pontuação, correlação, níveis, justificativa
├── analysis.ts         coleta → análise → pontuação, com prazo de 5 s
├── container.ts        cópia isolada, docker/podman run, liberações (ÚNICO módulo que inicia processos)
├── environmentCheck.ts comando "Verificar ambiente"
├── sandboxCommands.ts  comandos e diálogos de sandbox e liberação
├── panelHtml.ts        HTML do painel (puro, testável)
├── panel.ts            webview e inspeção de código
├── telemetry.ts        registro JSONL
└── hostActivity.ts     observa terminal, tarefas e depurador
```

### Decisões de segurança

- **Nenhum módulo de análise executa nada.** Só `container.ts` importa `child_process`, e um teste falha se isso mudar.
- **O coletor não sai do workspace:** não segue links simbólicos, não lê caminhos com `..`, `~` ou `$VAR`, respeita 1 MB por arquivo e 200 arquivos.
- **Contenção:**
  - só a cópia do projeto é montada no container, sem `node_modules`, `.git` e links simbólicos;
  - a cópia é de mão única: nada volta sozinho para o projeto real;
  - a rede **não** é desligada, porque `npm install` precisa dela: a proteção vem da ausência de segredos no container;
  - portas liberadas ficam acessíveis só nesta máquina, não na rede local;
  - o valor de uma variável liberada não aparece na linha de comando;
  - o socket do Docker não pode ser montado.
- **Painel:**
  - todo conteúdo do repositório é escapado;
  - política de segurança de conteúdo (CSP) com nonce, sem recursos externos;
  - mensagens do webview são validadas e o arquivo a abrir nunca vem delas;
  - caracteres bidirecionais (Trojan Source) viram marcadores visíveis.
- **Exceção ao silêncio:** uma evidência que roda fora do container (tarefa `folderOpen`, `initializeCommand`) garante no mínimo o nível MÉDIO, porque ali a contenção não protege.

### Limitações conhecidas

- **Rede local e metadados de nuvem:** com a rede ligada, o container ainda alcança serviços da rede local e, em máquinas virtuais de nuvem, o endpoint de metadados (169.254.169.254).
- **Limites da análise estática:** `require(variavel)` dinâmico, código baixado em tempo de execução e dependências instaladas a partir de URLs git ou `.tgz` não são analisados. Nesses casos, a proteção é o container.
- **Corpos de `class` no `setup.py`** são tratados como código que não roda no carregamento, embora em Python eles rodem.
- **Tarefas automáticas:** a API do VS Code não informa se uma tarefa iniciada era `folderOpen`. Cruze o nome registrado com o `tasks.json` do desafio.
