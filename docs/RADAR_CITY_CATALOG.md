# Catálogo nacional de municípios

O Radar usa um snapshot local com os 5.571 municípios brasileiros reconhecidos pelo IBGE. Cadastro e busca não consultam serviços externos.

## Versão e fontes

- Versão: `IBGE-Localidades-current+MMD-2025`
- Snapshot: `2026-08-26`
- Nomes, UFs e códigos: API de Localidades do IBGE, rota nacional de municípios.
- Coordenadas aproximadas: centróide da Malha Municipal Digital do IBGE 2025, SIRGAS 2000 (EPSG:4674).
- SHA-256 do arquivo oficial `BR_Municipios_2025.zip`: `840bbe6f73726ef9d1460ce49fdfe01a278935c41180d3c893e25ca21db083bd`
- SHA-256 da resposta da API de Localidades usada: `d9eec8439bc8c5dc2f7db6332a8e5569f5a3f637988e26aebc513412d4069d5c`
- SHA-256 das linhas do catálogo: `f32385fb3536d475ace54a7e6b7fb834c3499929d864d2170f149996a78c7e83`

As URLs e os checksums dos componentes da malha também ficam no bloco `metadata` de `src/friendlies/data/brazilian-municipalities-2025.json`.

## Atualização reproduzível

1. Baixar a resposta atual de `https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome`.
2. Baixar e extrair `BR_Municipios_2025.zip` da área de Malhas Municipais do IBGE, substituindo `2025` pela nova edição quando publicada.
3. Executar `node scripts/update-brazil-city-catalog.js --localities municipios.json --mesh-archive BR_Municipios_2025.zip --dbf BR_Municipios_2025.dbf --shp BR_Municipios_2025.shp --output src/friendlies/data/brazilian-municipalities-2025.json`.
4. Revisar a versão e a data do snapshot no gerador quando houver nova edição.
5. Executar a suíte completa. O gerador e os testes recusam códigos malformados, códigos repetidos, cidade/UF repetida, coordenadas inválidas, contagem diferente de 5.571 ou ausência de qualquer UF/DF.

As duas áreas operacionais de lagos presentes na malha do Rio Grande do Sul não entram no catálogo porque não constam na lista oficial de municípios da API de Localidades.
