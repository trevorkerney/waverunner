import { Modal, LibraryLocation } from '../../ts/types';

import './Sidebar.css'

const lls: LibraryLocation[] = [
  {
    name: 'Films',
    path: 'pathtofilms',
  },
  {
    name: 'Television',
    path: 'pathtotv',
  }
]

const ffs: LibraryLocation[] = [
  {
    name: 'Comedy',
    path: 'pathtofilms',
  },
  {
    name: 'Scorsese',
    path: 'pathtotv',
  }
]

const Sidebar = (props: {
  isSidebarOpen: boolean,
  toggleSidebar: () => void,
  setModal: (modal: Modal) => void,
  libLocations: LibraryLocation[]
}) => {
  return (
    <nav
      id='sidebar'
      style={
        (!props.isSidebarOpen)
        ? { width: '3rem' }
        : { width: '15rem' }
      }
    >
      <div id='logo-box'>
        <img src='/icons/logo256.png' alt='Waverunner' />
      </div>

      <div id='sb-bottom'>
        
        <div
          id='sb-cont'
          style={
            (props.isSidebarOpen)
            ? { display: 'block' }
            : { display: 'none' }
          }
        >
          <ul>
            {
              lls.map(loc => {
                return (
                  <li key={loc.path}>
                    <button>
                      <p>{loc.name}</p>
                    </button>
                  </li>
                );
              })
            }
            <li id='new-lib-flt'>
              <button onClick={() => {props.setModal(Modal.Library)}}>
                <img src='/icons/circlePlus.png' alt='new library' />
                <p>new library</p>
              </button>
            </li>
          </ul>

          <hr />

          <ul>
            {
              ffs.map(loc => {
                return (
                  <li key={loc.path}>
                    <button>
                      <p>{loc.name}</p>
                    </button>
                  </li>
                );
              })
            }
            <li id='new-lib-flt'>
              <button>
                <img src='/icons/circlePlus.png' alt='new filter' />
                <p>new filter</p>
              </button>
            </li>
          </ul>

        </div>

        <div id='sb-btn-box'>
          <button onClick={() => {props.toggleSidebar()}}>
            <img src='/icons/handle.png' alt='open/close sidebar' />
          </button>
        </div>

      </div>
    </nav>
  )
};

export default Sidebar;
