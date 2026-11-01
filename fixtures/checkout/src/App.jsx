import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
function Checkout(){
  const [quantity,setQuantity]=useState('3');
  const [result,setResult]=useState(null);
  const [message,setMessage]=useState('Calculating your order…');
  const [pending,setPending]=useState(false);
  async function update(event){
    event?.preventDefault();setPending(true);
    try{
      const response=await fetch('/api/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unitPriceCents:1999,quantity:Number(quantity),taxBasisPoints:825})});
      const body=await response.json();if(!response.ok)throw new Error(body.error);setResult(body);setMessage('Order total calculated');
    }catch(error){setResult(null);setMessage(error.message);}finally{setPending(false);}
  }
  useEffect(()=>{void update();},[]);
  return <main>
    <header><a className="brand" href="/" aria-label="Orbit home"><span className="brand-mark"/>orbit<span className="brand-period">.</span></a><span className="demo-label">SENTINEL / CONTROLLED DEMONSTRATION</span></header>
    <div className="intro"><span className="eyebrow">THE CHECKOUT EXPERIMENT</span><h1>Small details.<br/><span>Real consequences.</span></h1><p>A real React checkout. A real HTTP response.<br/>One missed cent that ordinary tests don’t catch.</p></div>
    <section className="checkout" aria-label="Checkout">
      <div className="product"><div className="product-image" role="img" aria-label="Illustration of the Orbit desk light"><div className="lamp-shade"/><div className="lamp-stem"/><div className="lamp-base"/><div className="glow"/></div><div className="product-description"><span className="eyebrow">MADE FOR YOUR SPACE</span><h2>Orbit desk light</h2><p>Soft light. Clear thinking.</p><span className="unit-price">$19.99 <small>each</small></span></div></div>
      <form onSubmit={update} className="summary"><div className="summary-top"><h2>Your order</h2><span className="step">01 / 01</span></div><label htmlFor="quantity">Quantity</label><div className="quantity-row"><input id="quantity" data-testid="quantity" type="number" min="1" max="100" value={quantity} onChange={event=>setQuantity(event.target.value)}/><button data-testid="update" type="submit" disabled={pending}>Update total <span aria-hidden="true">↗</span></button></div><dl><div><dt>Subtotal</dt><dd data-testid="subtotal">{result?money(result.subtotalCents):'—'}</dd></div><div><dt>Sales tax <span>(8.25%)</span></dt><dd data-testid="tax">{result?money(result.taxCents):'—'}</dd></div><div className="total"><dt>Total</dt><dd data-testid="total">{result?money(result.totalCents):'—'}</dd></div></dl><p className="status" role="status" data-testid="status"><span/>{message}</p><div className="boundary">DEMO ONLY · NO PAYMENT IS COLLECTED</div></form>
    </section>
    <footer><span>AI writes the code.</span><strong>SENTINEL establishes what works.</strong><span>Observed in a real browser.</span></footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<Checkout/>);
