import { GeneratedViews } from './views/GeneratedViews/GeneratedViews';
import { PageBody } from './components/PageBody'
import { Sidebar } from './components/Sidebar';
import { Container, Row, Col } from 'react-bootstrap'

function App() {

  return (
    <div className="app-wrapper">
      <Container fluid className="p-0">
        <Row className="g-0">
          <Col xs={2}>
            <Sidebar/>
          </Col>
          <Col xs={10}>
            <PageBody/>
          </Col>
        </Row>
      </Container>
    </div>
  )
}

/*
function App() {
  return (
    <>
      <TopNav />
      <div style={{ marginTop: 48 }}>
        <GeneratedViews />
      </div>
    </>
  );
}
*/

export default App;
