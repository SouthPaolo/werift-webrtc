import { setTimeout } from "../../common/src";

import { dtlsTransportPair } from "../fixture";

jest.setTimeout(10_000);

describe("RTCDtlsTransportTest", () => {
  test("dtls_test_data", async () => {
    const [session1, session2] = await dtlsTransportPair();
    const receiver2 = new DummyDataReceiver();
    session2.dataReceiver = receiver2.handleData;

    session1.sendData(Buffer.from("ping"));
    await setTimeout(100);
    expect(receiver2.data).toEqual([Buffer.from("ping")]);
  });
});

class DummyDataReceiver {
  data: Buffer[] = [];
  handleData = (data: Buffer) => {
    this.data.push(data);
  };
}
