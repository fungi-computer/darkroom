import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const fungiNamespace = "https://fungi.computer/ns/provenance/1.0/";
const iptcNamespace = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";
const rdfNamespace = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

/** Whitelist public identity, never copy provider or Fungi private XMP wholesale. */
export function publicProvenancePacket(packet?: string): string {
  const parser = new DOMParser({
    onError: () => {
      throw new Error("Invalid provenance XML");
    },
  });
  const source = packet
    ? parser.parseFromString(packet, "application/xml")
    : undefined;
  const value = (namespace: string, name: string) => {
    const element = source?.getElementsByTagNameNS(namespace, name).item(0);
    if (element?.textContent) return element.textContent;
    const descriptions = source?.getElementsByTagNameNS(
      rdfNamespace,
      "Description",
    );
    if (!descriptions) return undefined;
    for (let index = 0; index < descriptions.length; index++) {
      const attribute = descriptions
        .item(index)
        ?.getAttributeNS(namespace, name);
      if (attribute) return attribute;
    }
    return undefined;
  };
  const output = parser.parseFromString(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>',
    "application/xml",
  );
  const description = output
    .getElementsByTagNameNS(rdfNamespace, "Description")
    .item(0);
  if (!description) throw new Error("Missing provenance description");
  const fields = [
    { namespace: fungiNamespace, name: "printId", qualified: "fungi:printId" },
    {
      namespace: iptcNamespace,
      name: "DigitalSourceType",
      qualified: "Iptc4xmpExt:DigitalSourceType",
    },
  ];
  for (const { namespace, name, qualified } of fields) {
    const text = value(namespace, name);
    if (text === undefined) continue;
    const element = output.createElementNS(namespace, qualified);
    element.textContent = text;
    description.appendChild(element);
  }
  return new XMLSerializer().serializeToString(output);
}
