import IRToJavascript from "../intermediateLanguage/IR.js";


onmessage = m => {
	if (m.data !== undefined) {
		try {
			// postMessage({
			// 	treeTS: 1
			// });
      // console.log("DEBUG:il.worker:onmessage:data");
			// console.log(JSON.stringify(m.data.liveCodeAbstractSyntaxTree));

      // console.log("DEBUG:il.worker:onmessage:treeToCode");
			let dspCode = IRToJavascript.treeToCode(
				m.data.liveCodeAbstractSyntaxTree[0] //take the first grammer in case the grammar was ambiguous
			);

      // console.log("DEBUG:il.worker:onmessage:dspCode");
      // console.log(dspCode);

			dspCode.paramMarkers = JSON.stringify(dspCode.paramMarkers);
			postMessage(dspCode);
		} catch (err) {
      // console.log("DEBUG:il.worker:onmessage:catch");
			console.log(err);
		}
	}
};
