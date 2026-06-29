import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('frontend.render_error', { error, info });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="fatal-error" role="alert">
        <AlertTriangle size={28} />
        <h1>Algo salió mal</h1>
        <p>La vista no pudo renderizarse correctamente. Recargá la página para continuar.</p>
        <button type="button" onClick={() => window.location.reload()}>Recargar</button>
      </div>
    );
  }
}
