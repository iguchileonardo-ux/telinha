# Telinha — contexto para o Claude

App desktop (Windows) do Leo para a turma de amigos: chat, call de voz, compartilhamento de tela, reações, ponteiro/desenho, rádio do YouTube. Tudo P2P (WebRTC), sem VPN, entrada por convite `telinha://sala/xxxx-xxxx-xxxx`.

- Pasta no PC: `C:\Users\leona\Documents\Telinha`
- Repositório: https://github.com/iguchileonardo-ux/telinha (público)
- Servidor: https://telinha.leomaig.workers.dev (Cloudflare, plano grátis)
- Instalador para os amigos: `Documentos\Telinha Instalador\Telinha-Instalador.exe` (atalho "Telinha Instalador" na Área de Trabalho). Envio pelo WhatsApp, porque passa do limite do Discord.

## Preferências do Leo

- Interface minimalista e limpa. Nada de poluir a tela com botões.
- Mensagens no código e na interface sem tom informal e sem ponto de exclamação.
- Textos para o usuário em português do Brasil.
- Ele não é desenvolvedor da ferramenta no dia a dia: tudo deve ser possível com dois cliques em arquivos `.bat`.

## Stack

- Electron 44.5.1, esbuild (bundle IIFE, porque `file://` não carrega ES modules), electron-builder 26.15.3 (NSIS oneClick), electron-updater 6.8.9 (GitHub Releases).
- Trystero 0.25.4: `@trystero-p2p/ws-relay` (servidor próprio) e `@trystero-p2p/nostr` (reserva).
- Nativo (Windows): koffi 3.3.2 (janela, processo, jogos) e loopback-capture 3.0.2 (áudio de processo sem eco, WASAPI).
- Servidor: Cloudflare Worker + Durable Object com hibernação (`servidor-cloudflare/`), compatível com o protocolo do ws-relay (subscribe/unsubscribe/publish por tópico). `GET /turn` gera credenciais do Cloudflare TURN (secrets `TURN_KEY_ID` e `TURN_KEY_API_TOKEN`, ainda não configurados porque exigem cartão).

## Estrutura

```
app/main.js            processo principal: janela, bandeja, notificações, captura, IPC, servidor/TURN, atualização, registro de diagnóstico
app/radio.js           player do YouTube escondido (rádio)
app/overlay.js         camada transparente do ponteiro/desenho sobre a tela de quem transmite
app/audio.js, native.js
app/renderer/src/
  turma.js             rede: presença, chat, call, telas, ponte, reconexão, medição de conexão
  main.js              fluxo do app, configurações, escolha de servidor (builtin -> nostr)
  devices.js           escolha de microfone e saída
  alerts.js            sons sintetizados (WebAudio) e pedido de notificação ao processo principal
  ui/                  chat, call, reações, rádio, membros
servidor-cloudflare/   Worker (sinalização + TURN)
ferramentas/           scripts auxiliares (repo, servidor, node portátil)
```

## Como a conexão funciona

1. Sinalização: servidor da Telinha (`telinha.server` no package.json). Se não responder em 12 s, cai para relays Nostr fixos (lista testada em `NOSTR_RELAYS`, turma.js).
2. Mídia: WebRTC direto. Se duas pessoas não conectam direto: TURN (quando configurado) ou **ponte** (um membro ligado às duas repassa mensagens via ação `relay` e reenvia as streams; peers "virtuais" têm `via`).
3. Queda sem aviso (sem mensagem `bye`): reconecta fechando os sockets de sinalização (eles reabrem e reanunciam), com tentativas por até 10 min. Não derruba os outros.
4. Microfone desconectado: troca para o padrão e volta ao escolhido quando ele reaparece. Saída de áudio idem.
5. **Repasse de carga** (turma.js, seção final da classe): quem transmite mede a cada 2 s o próprio envio de vídeo (`qualityLimitationDurations` do WebRTC). Se a maioria das conexões fica limitada por banda ou processador por cerca de 20 s, passa espectadores para um repassador (um espectador conectado a eles). Um nível só: transmissor, repassador (até 3, ou 4 se for preciso), espectadores. Protocolo: o transmissor publica `sharing.relays` no `hello` (`{espectador: repassador}`); o repassador reenvia a stream com `metadata.relayFrom` e `metadata.sid`; o espectador confirma pela ação `feed` quando o vídeo chega, e só então o envio direto dele é pausado (`encoding.active = false`, sem renegociar). Falha, saída ou sobrecarga do repassador (`feed` com `ok: false`) devolvem o espectador ao envio direto e o repassador fica 5 min sem uso. Versões sem o campo `tree` do `hello` nunca entram no repasse. A escolha do repassador usa `up` (maior vazão de envio já medida naquele PC, guardada em `localStorage` `telinha:uplink`).

## Qualidade de vida (2.3.0)

- **Qualidade por envio**: `fanoutScale(n)` em turma.js reduz a taxa máxima de vídeo conforme o número de envios diretos (1 a 2: 100%, 3: 80%, 4: 65%, 5 ou mais: 50%, nunca abaixo de 1,5 Mbps). Vale em `#applyQuality` (transmissor) e `#tuneRelaying` (repassador, pelo número de espectadores dele).
- **Registro de diagnóstico**: `TurmaSession` emite o evento `log` (`#log`) com a entrada/saída de pessoas, caminho da conexão, sobrecarga, repasses, confirmações, quedas e um resumo a cada 30 s. A interface grava em `%APPDATA%\Telinha\diagnostico.txt` (limite de 1 MB, depois vira `diagnostico.antigo.txt`). Acesso discreto: clicar no texto da versão no rodapé das configurações abre a pasta. Não grava mensagens do chat nem o código das turmas.
- **Bandeja**: com "Manter na bandeja ao fechar" (padrão ligado), fechar a janela só a esconde e a call continua. Menu da bandeja: Abrir, Não incomodar (vale até fechar o app), Sair. Aviso único na primeira vez (`trayNoticeShown`). Sair de verdade: menu da bandeja ou `app.quit()` (a flag `quitting` vem de `before-quit` e de `update:install`).
- **Abrir com o Windows**: `app.setLoginItemSettings` com `--oculto`, só no app instalado. Com `--oculto` e bandeja ligada a janela nasce escondida (exceto se houver link `telinha://` pendente).
- **Notificações e sons**: o processo principal só mostra a notificação (silenciosa) com a janela em segundo plano e fora do Não incomodar; o som é feito na interface (`alerts.js`) e respeita a saída de áudio escolhida. Clicar na notificação abre a janela na aba certa (evento `notify:click`). A barra de tarefas pisca em mensagem nova com a janela sem foco.
- Preferências do processo principal ficam em `%APPDATA%\Telinha\preferencias.json`; as da interface em `telinha:settings` (`notifications`, `sounds`, `tray`, `autostart`). A interface reenvia as três primeiras ao abrir e ao salvar (`app:prefs`).

## Fluxo de trabalho

- Testes: Playwright com 2 ou 3 contextos, servidor estático em `app/renderer` (porta 5173), `server/server.mjs` (8080) e `wrangler dev` (8787). No navegador sem Electron, `window.__telinhaServer = { server, iceServers }` simula o servidor embutido e `?sala=<código>` entra direto numa turma. `window.__telinhaBlocked` (Set de peerIds) simula duas pessoas sem conexão direta.
- Repasse de carga nos testes: `globalThis.__telinhaLoad = (peerId) => ({ frac: 1, cpu: 0, kbps: 2500 })` força a medição de envio (sem ele, usa os dados reais do WebRTC). Com `frac: 1` em quem transmite e 3 a 6 contextos, o repasse entra em cerca de 25 s. `__telinhaBlocked` no repassador simula repasse que não entrega.
- Interface com ponte simulada: um `window.telinha` falso (Proxy que devolve funções assíncronas vazias) permite testar configurações, avisos e registro no navegador. `app/main.js` foi testado com um módulo `electron` falso (janela, bandeja, notificações e IPC simulados), sem abrir o Electron de verdade.
- Publicar versão: aumentar `version` no package.json e rodar `Publicar atualizacao.bat` (git push + tag `vX.Y.Z` + `electron-builder --publish always` + copia o instalador).
- Configurar servidor: `Configurar servidor.bat` (wrangler login/deploy, grava a URL no package.json, TURN opcional).

## Cuidados (erros que já aconteceram)

- **Nunca sobrescrever o package.json do PC com uma cópia antiga.** Ele guarda `telinha.updateRepo`, `telinha.server` e `build.publish`. Ler o arquivo do PC antes de editar. Na 2.1.2 e na 2.1.3 isso desligou a atualização automática; hoje `main.js` tem `DEFAULT_UPDATE_REPO` como proteção.
- A ferramenta de enviar arquivos ao PC às vezes gravou conteúdo velho. Conferir tamanho/conteúdo depois de gravar.
- A Release do GitHub precisa que a tag exista antes (o script já faz o push da tag).
- Relays Nostr públicos morrem sem aviso; testar de verdade (publicar evento efêmero e receber de volta) antes de confiar.
- O Trystero reaproveita o objeto de stream antigo quando o mesmo `MediaStream` é removido e reenviado ao mesmo destino: o destino fica com um stream sem faixas e sem imagem. Além disso, remover e reenviar a mesma tela ao mesmo destino renegocia a conexão e a estimativa de banda recomeça muito baixa (1 a 3 quadros por segundo por mais de 30 s). Por isso a tela é enviada uma só vez a cada pessoa e fica em pausa (`encoding.active = false`, em `#applyQuality`) quando ela sai da call ou passa a receber pelo repassador. Voz e ponte ainda removem e reenviam: no reenvio vai um `MediaStream` novo com o id verdadeiro em `metadata.sid` (`#addStreamTo`, `#removeStreamFrom`), e quem recebe usa `metadata.sid` como chave.
- Com "Efeitos de animação" do Windows desligados, `animationend` não dispara: toda animação que remove elemento precisa de `setTimeout` de reserva.

## Situação em 06/10/2026

- Versão 2.2.0 publicada e conferida no GitHub (Release v2.2.0 com `latest.yml`, instalador e `.blockmap`): servidor próprio, reconexão, troca automática de microfone, indicador de conexão, teste de microfone, aviso de mutado.
- **Versão 2.3.0 escrita no PC, ainda não publicada** (package.json já está em 2.3.0). Para publicar: rodar `Publicar atualizacao.bat`. Contém: repasse de carga, correção de quem sai e volta da call, qualidade por número de envios, registro de diagnóstico, bandeja, abrir com o Windows, notificações, sons, Não incomodar, e a correção do `net` que faltava no import de `app/main.js` (a busca das credenciais TURN falharia assim que o TURN fosse configurado).
- Testado: repasse com Playwright em 2 a 6 navegadores (Chromium), incluindo quem chega depois, repassador que sai, que não entrega e que fica no limite; interface com ponte simulada; `app/main.js` com Electron simulado. **Não testado no Electron real nem em redes reais**: bandeja, notificação do Windows, início com o Windows, repasse e qualidade por envio. Ao testar a 2.3.0 instalada, conferir: fechar a janela deixa o ícone na bandeja, Sair encerra, notificação aparece com a janela em segundo plano e o clique abre a aba certa, e o registro aparece em `%APPDATA%\Telinha\diagnostico.txt`.
- Quem instalou a 2.1.2 ou 2.1.3 pelo instalador precisa reinstalar a 2.2.0 uma vez (essas versões saíram sem atualização automática e não viraram Releases visíveis). Quem está na 2.1.0 atualiza sozinho.
- TURN não configurado (exige cartão no Cloudflare). A ponte cobre o caso de 3+ pessoas.
- Ainda não testado em PCs reais: ponte, reconexão após queda de Wi-Fi, ponteiro sobre a tela de quem transmite, detecção de jogo.
- Ideias aprovadas para depois: push-to-talk global, gerar novo convite e remover membro, supressão de ruído melhor (RNNoise), voz com prioridade de estabilidade (estéreo só no som da tela). Outras ações de qualidade de vida em estudo (Leo ainda vai escolher): atalho global para silenciar o microfone, copiar o quadro da tela recebida, lembrar tamanho e posição da janela.
