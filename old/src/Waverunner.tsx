// import { invoke } from '@tauri-apps/api/tauri'

import { useState } from "react";

import Sidebar from "./components/Sidebar/Sidebar";
import Titlebar from "./components/Titlebar/Titlebar";

import NewLibraryModal from "./modals/newLibraryModal/NewLibraryModal";

import { Modal, LibraryLocation } from "./ts/types";

import "./Waverunner.css";

const Waverunner = () => {

  const [modal, _setModal] = useState<Modal>(Modal.None);
  const setModal = (modal: Modal) => _setModal(modal);
  const exitModal = () => _setModal(Modal.None);

  const [isSidebarOpen, _setIsSidebarOpen] = useState<boolean>(true);
  const toggleSidebar = () => _setIsSidebarOpen(prev => !prev);

  const [libLocations, _setLibLocations] = useState<LibraryLocation[]>([]);

  return (
    <div id='waverunner'>
      <Titlebar />
      <main>

        {
          (!!modal) && (
            <>
              <div id='modal-bg' />
              <div id='modal-box'>
                {
                  (() => {
                    switch (modal) {
                      case Modal.Library: return <NewLibraryModal exitModal={exitModal} />
                      default: setModal(Modal.None)
                    };
                  })()
                }
              </div>
            </>
          )
        }

        <Sidebar
          setModal={setModal}
          isSidebarOpen={isSidebarOpen}
          toggleSidebar={toggleSidebar}
          libLocations={libLocations}
        />

      </main>
    </div>
  );
}

export default Waverunner;
