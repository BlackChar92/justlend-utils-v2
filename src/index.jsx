/*
 * Copyright 2026 Justlend V2 Utils. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import Example from "./Example.jsx";
import { WalletProvider } from "@tronweb3/tronwallet-adapter-react-hooks";
import { TronLinkAdapter } from "@tronweb3/tronwallet-adapter-tronlink";

function Root() {
  const adapters = useMemo(() => [new TronLinkAdapter()], []);

  return (
    <WalletProvider adapters={adapters} autoConnect={true}>
      <Example />
    </WalletProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);
