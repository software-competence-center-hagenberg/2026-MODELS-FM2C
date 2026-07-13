import { Container, Row, Col, Badge } from 'react-bootstrap'

type CardHeaderProps = {
  number: string | number;
  title: string;
  description: string;
};

export function CardHeader({ number, title, description }: CardHeaderProps) {
  return (
    <Container fluid>
      <Row>
        <Col>
        <Row className='gv-header-row'>
            <Col xs={1}>
                <Badge pill className="number-badge">{number}</Badge>
            </Col>
            <Col>
              <Row className='gv-header-text'>{title}</Row>
              <Row className="gv-header-subtitle">{description}</Row>
            </Col>
        </Row>
          
        </Col>
        
      </Row>
    </Container>
  );
}