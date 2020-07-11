import {
  RTCRtpParameters,
  RTCRtcpFeedback,
  RTCRtpHeaderExtensionParameters,
  RTCRtpCodecParameters,
} from "./parameters";
import { RTCIceParameters, RTCIceCandidate } from "./transport/ice";
import { RTCDtlsParameters, RTCDtlsFingerprint } from "./transport/dtls";
import { RTCSctpCapabilities } from "./transport/sctp";
import {
  DTLS_ROLE_SETUP,
  DTLS_SETUP_ROLE,
  FMTP_INT_PARAMETERS,
  SSRC_INFO_ATTRS,
} from "./const";
import { isIPv4 } from "net";
import { range } from "lodash";
import { randomBytes } from "crypto";
import { Uint64BE } from "int64-buffer";
import { assignClassProperties } from "../helper";

export class SessionDescription {
  version = 0;
  origin?: string;
  name = "-";
  time = "0 0";
  host?: string;
  group: GroupDescription[] = [];
  msidSemantic: GroupDescription[] = [];
  media: MediaDescription[] = [];
  type?: "offer" | "answer";

  static parse(sdp: string) {
    const dtlsFingerprints: RTCDtlsFingerprint[] = [];
    let dtlsRole = "";
    let iceOptions = undefined;
    let iceLite = false;
    let icePassword = "";
    let iceUsernameFragment = "";

    const [sessionLines, mediaGroups] = groupLines(sdp);

    const session = new SessionDescription();
    sessionLines.forEach((line) => {
      if (line.startsWith("v=")) {
        session.version = parseInt(line.slice(2), 10);
      } else if (line.startsWith("o=")) {
        session.origin = line.slice(2);
      } else if (line.startsWith("s=")) {
        session.name = line.slice(2);
      } else if (line.startsWith("c=")) {
        session.host = ipAddressFromSdp(line.slice(2));
      } else if (line.startsWith("t=")) {
        session.time = line.slice(2);
      } else if (line.startsWith("a=")) {
        const [attr, value] = parseAttr(line);
        switch (attr) {
          case "fingerprint":
            const [algorithm, fingerprint] = value?.split(" ") || [];
            dtlsFingerprints.push(
              new RTCDtlsFingerprint(algorithm, fingerprint)
            );
            break;
          case "ice-lite":
            iceLite = true;
            break;
          case "ice-options":
            iceOptions = value;
            break;
          case "ice-pwd":
            icePassword = value;
            break;
          case "ice-ufrag":
            iceUsernameFragment = value;
            break;
          case "group":
            if (!value) throw new Error("exception");
            parseGroup(session.group, value);
            break;
          case "msid-semantic":
            if (!value) throw new Error("exception");
            parseGroup(session.msidSemantic, value);
            break;
          case "setup":
            dtlsRole = DTLS_ROLE_SETUP[value];
            break;
        }
      }
    });

    mediaGroups.forEach((mediaLines) => {
      const target = mediaLines[0];
      const m = target.match(/^m=([^ ]+) ([0-9]+) ([A-Z\/]+) (.+)/);
      if (!m) {
        throw new Error();
      }

      const kind = m[1];
      const fmt = m[4].split(" ");
      // todo fix
      const fmtInt = ["audio", "video"].includes(kind)
        ? fmt.map((v) => Number(v))
        : undefined;

      const currentMedia = new MediaDescription(
        kind,
        parseInt(m[2]),
        m[3],
        fmtInt || fmt
      );
      currentMedia.dtls = new RTCDtlsParameters(
        [...dtlsFingerprints],
        dtlsRole as any
      );
      currentMedia.ice = new RTCIceParameters({
        iceLite,
        usernameFragment: iceUsernameFragment,
        password: icePassword,
      });
      currentMedia.iceOptions = iceOptions;
      session.media.push(currentMedia);

      mediaLines.slice(1).forEach((line) => {
        if (line.startsWith("c=")) {
          currentMedia.host = ipAddressFromSdp(line.slice(2));
        } else if (line.startsWith("a=")) {
          const [attr, value] = parseAttr(line);

          switch (attr) {
            case "candidate":
              if (!value) throw new Error();
              currentMedia.iceCandidates.push(candidateFromSdp(value));
              break;
            case "end-of-candidates":
              currentMedia.iceCandidatesComplete = true;
              break;
            case "extmap":
              let [extId, extUri] = value.split(" ");
              if (extId.includes("/")) {
                [extId] = extId.split("/");
              }
              currentMedia.rtp.headerExtensions.push(
                new RTCRtpHeaderExtensionParameters({
                  id: parseInt(extId),
                  uri: extUri,
                })
              );
              break;
            case "fingerprint":
              if (!value) throw new Error();
              const [algorithm, fingerprint] = value.split(" ");
              currentMedia.dtls?.fingerprints.push(
                new RTCDtlsFingerprint(algorithm, fingerprint)
              );
              break;
            case "ice-options":
              currentMedia.iceOptions = value;
              break;
            case "ice-pwd":
              currentMedia.ice.password = value;
              break;
            case "ice-ufrag":
              currentMedia.ice.usernameFragment = value;
              break;
            case "max-message-size":
              currentMedia.sctpCapabilities = new RTCSctpCapabilities(
                parseInt(value, 10)
              );
              break;
            case "mid":
              currentMedia.rtp.muxId = value;
              break;
            case "msid":
              currentMedia.msid = value;
              break;
            case "rtcp":
              const [port, rest] = value.split(" ", 1);
              currentMedia.rtcpPort = parseInt(port);
              currentMedia.rtcpHost = ipAddressFromSdp(rest);
              break;
            case "rtcp-mux":
              currentMedia.rtcpMux = true;
              break;
            case "setup":
              currentMedia.dtls.role = DTLS_SETUP_ROLE[value];
              break;
            case "rtpmap":
              {
                const [formatId, formatDesc] = value.split(" ", 1);
                const bits = formatDesc.split("/");
                let channels: number | undefined;
                if (currentMedia.kind === "audio") {
                  channels = bits.length > 2 ? parseInt(bits[2]) : 1;
                }
                const codec = new RTCRtpCodecParameters({
                  mimeType: currentMedia.kind + "/" + bits[0],
                  channels,
                  clockRate: parseInt(bits[1]),
                  payloadType: parseInt(formatId),
                });
                currentMedia.rtp.codecs.push(codec);
              }
              break;
            case "sctpmap":
              if (!value) throw new Error();
              const [formatId, formatDesc] = value.split(" ", 1);
              (currentMedia as any)[attr][parseInt(formatId)] = formatDesc;
              break;
            case "sctp-port":
              if (!value) throw new Error();
              currentMedia.sctpPort = parseInt(value);
              break;
            case "ssrc-group":
              // todo fix
              parseGroup(currentMedia.ssrcGroup, value, parseInt);
              break;
            case "ssrc":
              const [ssrcStr, ssrcDesc] = value.split(" ", 1);
              const ssrc = parseInt(ssrcStr);
              const [ssrcAttr, ssrcValue] = ssrcDesc.split(":", 1);
              let ssrcInfo = currentMedia.ssrc.find((v) => v.ssrc === ssrc);
              if (!ssrcInfo) {
                ssrcInfo = new SsrcDescription({ ssrc });
                currentMedia.ssrc.push(ssrcInfo);
              }
              if (SSRC_INFO_ATTRS.includes(ssrcAttr)) {
                ssrcInfo[ssrcAttr] = ssrcValue;
              }
              break;
          }
        }
      });

      if (!currentMedia.dtls.role) {
        currentMedia.dtls = undefined;
      }

      const findCodec = (pt: number) =>
        currentMedia.rtp.codecs.find((v) => v.payloadType === pt);

      mediaLines.slice(1).forEach((line) => {
        if (line.startsWith("a=")) {
          const [attr, value] = parseAttr(line);
          if (attr === "fmtp") {
            const [formatId, formatDesc] = value.split(" ", 1);
            const codec = findCodec(Number(formatId));
            codec.parameters = parametersFromSdp(formatDesc);
          } else if (attr === "rtcp-fb") {
            const bits = value.split(" ", 2);
            currentMedia.rtp.codecs.forEach((codec) => {
              if (["*", codec.payloadType].includes(bits[0])) {
                codec.rtcpFeedback.push(
                  new RTCRtcpFeedback({
                    type: bits[1],
                    parameter: bits.length > 2 ? bits[2] : undefined,
                  })
                );
              }
            });
          }
        }
      });
    });

    return session;
  }

  toString() {
    const lines = [`v=${this.version}`, `o=${this.origin}`, `s=${this.name}`];
    if (this.host) {
      lines.push(`c=${ipAddressFromSdp(this.host)}`);
    }
    lines.push(`t=${this.time}`);
    this.group.forEach((group) => lines.push(`a=group:${group.str()}`));
    this.msidSemantic.forEach((group) =>
      lines.push(`a=msid-semantic:${group.str()}`)
    );
    const sdp = lines.join("\r\n") + "\r\n" + this.media.map((m) => m);
    return sdp;
  }
}

export class MediaDescription {
  // rtp
  host?: string;
  direction?: string;
  msid?: string;

  // rtcp
  rtcpPort?: number;
  rtcpHost?: string;
  rtcpMux = false;

  // ssrc
  ssrc: SsrcDescription[] = [];
  ssrcGroup: GroupDescription[] = [];

  // formats
  rtp = new RTCRtpParameters();

  // sctp
  sctpCapabilities?: RTCSctpCapabilities;
  sctpMap: { [key: number]: string } = {};
  sctpPort?: number;

  // DTLS
  dtls?: RTCDtlsParameters;

  // ICE
  ice?: RTCIceParameters;
  iceCandidates: RTCIceCandidate[] = [];
  iceCandidatesComplete = false;
  iceOptions?: string;
  constructor(
    public kind: string,
    public port: number,
    public profile: string,
    public fmt: string[] | number[]
  ) {}

  toString() {
    const lines = [];
    lines.push(
      `m=${this.kind} ${this.port} ${this.profile} ${(this.fmt as number[])
        .map((v) => v.toString())
        .join(" ")}`
    );
    if (this.host) {
      lines.push(`c=${ipAddressToSdp(this.host)}`);
    }
    if (this.direction) {
      lines.push(`a=${this.direction}`);
    }

    if (this.rtp.muxId) {
      lines.push(`a=mid:${this.rtp.muxId}`);
    }
    if (this.msid) {
      lines.push(`a=msid:${this.msid}`);
    }

    Object.keys(this.sctpMap).forEach((k) => {
      const v = this.sctpMap[Number(k)];
      lines.push(`a=sctpmap:${k} ${v}`);
    });
    if (this.sctpPort) {
      lines.push(`a=sctp-port:${this.sctpPort}`);
    }
    if (this.sctpCapabilities) {
      lines.push(`a=max-message-size:${this.sctpCapabilities.maxMessageSize}`);
    }

    // ice
    this.iceCandidates.forEach((candidate) => {
      lines.push(`a=candidate:${candidateToSdp(candidate)}`);
    });
    if (this.iceCandidatesComplete) {
      lines.push("a=end-of-candidates");
    }
    if (this.ice.usernameFragment) {
      lines.push(`a=ice-ufrag:${this.ice.usernameFragment}`);
    }
    if (this.ice.password) {
      lines.push(`a=ice-pwd:${this.ice.password}`);
    }
    if (this.iceOptions) {
      lines.push(`a=ice-options:${this.iceOptions}`);
    }

    // dtls
    if (this.dtls) {
      this.dtls.fingerprints.forEach((fingerprint) => {
        lines.push(
          `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`
        );
      });
      if (!this.dtls.role) throw new Error();
      lines.push(`a=setup:${DTLS_ROLE_SETUP[this.dtls.role]}`);
    }

    return lines.join("\r\n") + "\r\n";
  }
}

export class GroupDescription {
  constructor(public semantic: string, public items: (number | string)[]) {}

  str() {
    return `${this.semantic} ${this.items.join(" ")}`;
  }
}

function ipAddressFromSdp(sdp: string) {
  const m = sdp.match(/^IN (IP4|IP6) ([^ ]+)$/);
  if (!m) throw new Error("exception");
  return m[2];
}

function ipAddressToSdp(addr: string) {
  const version = isIPv4(addr) ? 4 : 6;
  return `IN IP${version} ${addr}`;
}

function candidateToSdp(c: RTCIceCandidate) {
  let sdp = `${c.foundation} ${c.component} ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
  if (c.relatedAddress) {
    sdp += ` raddr ${c.relatedAddress}`;
  }
  if (c.relatedPort) {
    sdp += ` rport ${c.relatedPort}`;
  }
  if (c.tcpType) {
    sdp += ` tcptype ${c.tcpType}`;
  }
  return sdp;
}

function groupLines(sdp: string): [string[], string[][]] {
  const session: string[] = [];
  const media: string[][] = [];

  sdp.split("\r\n").forEach((line) => {
    if (line.startsWith("m=")) {
      media.push([line]);
    } else if (media.length > 0) {
      media[media.length - 1].push(line);
    } else {
      session.push(line);
    }
  });

  return [session, media];
}

function parseAttr(line: string): [string, string | undefined] {
  if (line.includes(":")) {
    const bits = line.slice(2).split(":");
    return [bits[0], bits.slice(1).join(":")];
  } else {
    return [line.slice(2), undefined];
  }
}

function parseGroup(
  dest: GroupDescription[],
  value: string,
  type: (v: string) => any = (v) => v.toString()
) {
  const bits = value.split(" ");
  if (bits.length > 0) {
    dest.push(new GroupDescription(bits[0], bits.slice(1).map(type)));
  }
}

function candidateFromSdp(sdp: string) {
  const bits = sdp.split(" ");
  if (bits.length < 8) {
    throw new Error();
  }

  const candidate = new RTCIceCandidate(
    parseInt(bits[1], 10),
    bits[0],
    bits[4],
    parseInt(bits[5], 10),
    parseInt(bits[3], 10),
    bits[2],
    bits[7]
  );

  range(bits.length - 1, 8, 2)
    .reverse()
    .forEach((i) => {
      switch (bits[i]) {
        case "raddr":
          candidate.relatedAddress = bits[i + 1];
          break;
        case "rport":
          candidate.relatedPort = parseInt(bits[i + 1]);
          break;
        case "tcptype":
          candidate.tcpType = bits[i + 1];
          break;
      }
    });

  return candidate;
}

export class RTCSessionDescription {
  constructor(public sdp: string, public type: "offer" | "answer") {}
}

export function addSDPHeader(
  type: "offer" | "answer",
  description: SessionDescription
) {
  const username = "-";
  const sessionId = new Uint64BE(randomBytes(64)).toString();
  const sessionVersion = 0;

  description.origin = `${username} ${sessionId} ${sessionVersion} IN IP4 0.0.0.0`;
  description.msidSemantic.push(new GroupDescription("WMS", ["*"]));
  description.type = type;
}

function parametersFromSdp(sdp: string): number[] {
  const parameters = {};
  sdp.split(";").forEach((param) => {
    if (param.includes("=")) {
      const [k, v] = param.split("=", 1);
      if (FMTP_INT_PARAMETERS.includes(k)) {
        parameters[k] = Number(v);
      } else {
        parameters[k] = v;
      }
    } else {
      parameters[param] = undefined;
    }
  });
  return Object.keys(parameters)
    .sort()
    .map((i) => parameters[i]);
}

export class SsrcDescription {
  ssrc: number;
  cname?: string;
  msid?: string;
  msLabel?: string;
  label?: string;

  constructor(props: Partial<SsrcDescription>) {
    assignClassProperties(this, props);
  }
}