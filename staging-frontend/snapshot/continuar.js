"use strict";

const CONTINUAR_API_BASE = "https://api.omascote.com.br";
const CONTINUAR_HANDOFF_RE = /^[A-Za-z0-9_-]{43}$/;
const CONTINUAR_HANDOFF_PENDING_KEY = "omascote_browser_handoff_pending";
const CONTINUAR_CONTROLES_RE = /[\u0000-\u001f\u007f]/;
const CONTINUAR_CHAVES_PERMITIDAS = new Set([
  "fbclid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_id",
  "utm_term",
  "utm_content",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "produto"
]);

const continueStatus = document.getElementById("continueStatus");
const continueAction = document.getElementById("continueAction");
const continueRetry = document.getElementById("continueRetry");

function continuarSetStatus(texto, options = {}){
  if(continueStatus) continueStatus.textContent = texto;
  if(continueAction){
    continueAction.hidden = !options.permitirContinuar;
    if(options.destino) continueAction.href = options.destino.href;
  }
  if(continueRetry) continueRetry.hidden = !options.permitirTentarNovamente;
}

function continuarDetectarWebview(userAgent = navigator.userAgent){
  const ua = String(userAgent || "");
  if(/FBAN\/MessengerForiOS|FB_IAB\/MESSENGER|Orca-Android|Messenger/i.test(ua)) return "Messenger";
  if(/Instagram/i.test(ua)) return "Instagram";
  if(/WhatsApp/i.test(ua)) return "WhatsApp";
  if(/FBAN|FBAV|FB_IAB|FB4A|FBIOS/i.test(ua)) return "Facebook";
  return "";
}

function continuarValorSeguro(chave, valorOriginal){
  const valorBruto = String(valorOriginal || "");
  const valor = valorBruto.trim();
  const limite = chave === "produto" ? 64 : 300;
  if(!valor || valor.length > limite || CONTINUAR_CONTROLES_RE.test(valorBruto)) return "";
  if(chave === "produto" && !/^[a-z0-9_-]+$/i.test(valor)) return "";
  return valor;
}

function continuarDestinoSeguro(valorOriginal = ""){
  const destino = new URL("/app.html", location.origin);
  try{
    const candidato = new URL(valorOriginal || "/app.html", location.origin);
    if(candidato.origin !== location.origin || candidato.pathname !== "/app.html") return destino;

    for(const [chaveOriginal, valorOriginalParametro] of candidato.searchParams){
      const chave = String(chaveOriginal || "").toLowerCase();
      if(!CONTINUAR_CHAVES_PERMITIDAS.has(chave)) continue;
      const valor = continuarValorSeguro(chave, valorOriginalParametro);
      if(valor) destino.searchParams.set(chave, valor);
    }

    const ancora = candidato.hash.slice(1);
    if(ancora && ancora.length <= 200 && !CONTINUAR_CONTROLES_RE.test(ancora)){
      destino.hash = ancora;
    }
  }catch(e){}
  return destino;
}

function continuarLerHandoffDoFragmento(){
  try{
    const fragmento = new URLSearchParams(location.hash.slice(1));
    return String(fragmento.get("auth_handoff") || "").trim();
  }catch(e){
    return "";
  }
}

function continuarLerHandoffPendente(){
  try{ return String(sessionStorage.getItem(CONTINUAR_HANDOFF_PENDING_KEY) || "").trim(); }
  catch(e){ return ""; }
}

function continuarGuardarHandoffPendente(codigo){
  try{ sessionStorage.setItem(CONTINUAR_HANDOFF_PENDING_KEY, codigo); }catch(e){}
}

function continuarLimparHandoffPendente(){
  try{ sessionStorage.removeItem(CONTINUAR_HANDOFF_PENDING_KEY); }catch(e){}
}

function continuarLimparFragmento(){
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function continuarLimparCachesContaAnterior(){
  [
    "omascote_perfil_id",
    "ia4tube_pedidos_ativos",
    "ia4tube_pedidos_aguardando_pix",
    "ia4tube_pedidos_baixados"
  ].forEach(chave => localStorage.removeItem(chave));

  for(let i = localStorage.length - 1; i >= 0; i--){
    const chave = localStorage.key(i) || "";
    if(chave.startsWith("ia4tube_pedido_inicio_")) localStorage.removeItem(chave);
  }
}

function continuarSalvarSessao(data){
  // Um logout ou token expirado pode deixar pedidos da conta anterior em cache.
  // Limpa somente depois de o resgate ter sido confirmado pelo servidor.
  continuarLimparCachesContaAnterior();

  localStorage.setItem("omascote_token", data.token);
  localStorage.setItem("omascote_nome_time", String(data.nome_time || ""));
  localStorage.setItem("omascote_plano", String(data.plano ?? ""));
  localStorage.setItem("omascote_usados", String(data.usados_no_ciclo ?? ""));
  localStorage.setItem("omascote_saldo", String(data.saldo ?? ""));

  if(data.conta_auto_pendente === true){
    localStorage.setItem("ia4tube_conta_auto_pendente", "1");
  }else{
    localStorage.removeItem("ia4tube_conta_auto_pendente");
  }

}

async function continuarResgatarHandoff(codigo, destinoPadrao){
  continuarSetStatus("Validando sua continuação segura...");
  try{
    const r = await fetch(`${CONTINUAR_API_BASE}/auth/browser-handoff/redeem`, {
      method:"POST",
      cache:"no-store",
      credentials:"omit",
      referrerPolicy:"no-referrer",
      headers:{
        "Content-Type":"application/json",
        "Cache-Control":"no-cache"
      },
      body:JSON.stringify({ code:codigo })
    });
    const data = await r.json().catch(()=>({}));

    if(r.status === 410){
      continuarLimparHandoffPendente();
      continuarSetStatus(
        "Este link seguro expirou ou já foi usado. Entre normalmente para continuar; nenhuma nova conta foi criada.",
        { permitirContinuar:true, destino:destinoPadrao }
      );
      return;
    }

    if([400, 401, 403, 415, 422].includes(r.status)){
      continuarLimparHandoffPendente();
      continuarSetStatus(
        data.error || "O link seguro é inválido. Entre normalmente para continuar.",
        { permitirContinuar:true, destino:destinoPadrao }
      );
      return;
    }

    if(!r.ok || !data.ok || typeof data.token !== "string" || data.token.length < 20){
      continuarSetStatus(
        data.error || "Não foi possível validar o link agora. Tente novamente sem fechar esta tela.",
        {
          permitirContinuar:true,
          permitirTentarNovamente:true,
          destino:destinoPadrao
        }
      );
      return;
    }

    continuarSalvarSessao(data);
    continuarLimparHandoffPendente();
    continuarSetStatus("Sessão confirmada. Abrindo o Meu Clube FC...");
    location.replace(destinoPadrao.href);
  }catch(e){
    continuarSetStatus(
      "Não foi possível validar o link agora. Tente novamente sem fechar esta tela.",
      {
        permitirContinuar:true,
        permitirTentarNovamente:true,
        destino:destinoPadrao
      }
    );
  }
}

async function continuarConfirmarEResgatar(codigo, destino){
  const tokenExistente = localStorage.getItem("omascote_token");
  let substituirSessaoExistente = false;
  if(tokenExistente){
    substituirSessaoExistente = window.confirm(
      "Já existe uma conta conectada neste navegador. Deseja substituí-la pela conta trazida deste link seguro?"
    );
    if(!substituirSessaoExistente){
      continuarLimparHandoffPendente();
      continuarSetStatus(
        "A sessão que já estava neste navegador foi mantida. O link seguro não foi consumido.",
        { permitirContinuar:true, destino }
      );
      return;
    }
  }

  await continuarResgatarHandoff(codigo, destino);
}

async function continuarInicializar(){
  const entrada = new URL(location.href);
  const destino = continuarDestinoSeguro(entrada.searchParams.get("next") || "/app.html");
  const codigoFragmento = continuarLerHandoffDoFragmento();
  const codigoPendente = continuarLerHandoffPendente();
  const webview = continuarDetectarWebview();

  if((codigoFragmento || codigoPendente) && webview){
    continuarSetStatus(
      `Você ainda está dentro do ${webview}. Use o menu ⋮ e escolha “Abrir no navegador”. Sua sessão segura será confirmada somente no Chrome ou Safari.`
    );
    return;
  }

  let codigo = codigoFragmento || codigoPendente;
  if(codigoFragmento){
    // No navegador externo, preserva para retry antes de limpar o segredo da URL.
    continuarGuardarHandoffPendente(codigoFragmento);
    continuarLimparFragmento();
  }

  if(!codigo){
    continuarSetStatus("Abrindo o Meu Clube FC...");
    location.replace(destino.href);
    return;
  }

  if(!CONTINUAR_HANDOFF_RE.test(codigo)){
    continuarLimparHandoffPendente();
    if(codigoFragmento) continuarLimparFragmento();
    continuarSetStatus(
      "O link seguro é inválido. Entre normalmente para continuar.",
      { permitirContinuar:true, destino }
    );
    return;
  }

  continueRetry?.addEventListener("click", ()=>{
    const codigoPendente = continuarLerHandoffPendente();
    if(!CONTINUAR_HANDOFF_RE.test(codigoPendente)){
      continuarLimparHandoffPendente();
      continuarSetStatus(
        "O link seguro não está mais disponível. Entre normalmente para continuar.",
        { permitirContinuar:true, destino }
      );
      return;
    }
    void continuarConfirmarEResgatar(codigoPendente, destino);
  });

  await continuarConfirmarEResgatar(codigo, destino);
}

void continuarInicializar();
