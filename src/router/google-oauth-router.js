import { Router } from 'express';
import superagent from 'superagent';
// import { google } from 'googleapis';
import HttpErrors from 'http-errors';
import Profile from '../model/profile';

// These are modules you will need to create a MongoDB account based off the Google response
// import crypto from 'crypto'; // maybe you want to use this to create a password for your MongoDB account
// import jwt from 'jsonwebtoken'; // you will DEFINITELY need this to "sign" your Google token
// import Account from '../model/account';
import logger from '../lib/logger';
// import Whitelist from '../model/whitelist';

const GOOGLE_OAUTH_URL = 'https://www.googleapis.com/oauth2/v4/token';

const OPEN_ID_URL = 'https://www.googleapis.com/plus/v1/people/me/openIdConnect';

require('dotenv').config();

const googleOAuthRouter = new Router();

googleOAuthRouter.get('/api/v1/oauth/google', async (request, response, next) => {
  if (!request.query.code) {
    // logger.log(logger.ERROR, 'DID NOT GET CODE FROM GOOGLE');
    response.redirect(process.env.CLIENT_URL);
    return next(new HttpErrors(500, 'Google OAuth Code Error'));
  }
  // logger.log(logger.INFO, `RECVD CODE FROM GOOGLE AND SENDING IT BACK TO GOOGLE: ${request.query.code}`);

  let googleTokenResponse;
  try {
    googleTokenResponse = await superagent.post(GOOGLE_OAUTH_URL)
      .type('form')
      .send({
        code: request.query.code,
        access_type: 'offline',
        grant_type: 'authorization_code',
        client_id: process.env.GOOGLE_OAUTH_ID,
        client_secret: process.env.GOOGLE_OAUTH_SECRET,
        redirect_uri: `${process.env.API_URL}/oauth/google`,
      });
  } catch (err) {
    // logger.log(logger.ERROR, `ERROR FROM GOOGLE: ${JSON.stringify(err)}`);
    return next(new HttpErrors(err.status, 'Error from Google Oauth error fetching authorization tokens'));
  }

  // I'm thinking this code is pointless...
  if (!googleTokenResponse.body.access_token) {
    logger.log(logger.ERROR, 'No Token from Google');
    return response.redirect(process.env.CLIENT_URL);
  }

  const googleAccessToken = googleTokenResponse.body.access_token;

  let openIdResponse;
  try {
    openIdResponse = await superagent.get(OPEN_ID_URL)
      .set('Authorization', `Bearer ${googleAccessToken}`);
  } catch (err) {
    return next(new HttpErrors(err.status, 'OpenId request failed'));
  }

  const { email } = openIdResponse.body;
  const firstName = openIdResponse.body.given_name;
  const lastName = openIdResponse.body.family_name;
  const { picture } = openIdResponse.body;

  // at this point Oauth is complete. Now we need to see they are
  // in the profile collection

  let profile = await Profile.findOne({ email });

  if (!profile) {
    // user not in profile collection, check process.env.ROOT_ADMIN
    const rootAdmin = JSON.parse(process.env.ROOT_ADMIN);
    if (email !== rootAdmin.email) {
      return next(new HttpErrors(401, 'User not recognized'));
    }
    // they're authorized. Create a profile for them
    logger.log(logger.INFO, 'Creating ROOT_ADMIN profile');
    const newProfile = new Profile({
      email,
      firstName,
      lastName,
      picture,
      role: rootAdmin.role,
    });
    try {
      profile = await newProfile.save();
    } catch (err) {
      logger.log(logger.ERROR, `Error saving new ROOT ADMIN profile: ${err}`);
    }
  }

  // at this point we have a profile for sure
  if (!(profile.role === 'admin' || profile.role === 'mentor')) {
    return next(new HttpErrors(401, 'User not authorized.'));  
  }
  logger.log(logger.INFO, 'Profile validated');

  // in the previous version where we logged in and the fetched profile
  // basic and bearer auth middleware was invoked which put account,
  // profile and other stuff on the request object.  We need to keep 
  // at least the profile and auth stuff around...

  // this call returns a jwt with profileId and google tokens
  // as payload

  const raToken = await profile.createTokenPromise(googleTokenResponse.body);

  // send raToken as cookie and in response json
  const cookieOptions = { maxAge: 7 * 1000 * 60 * 60 * 24, secure: false, domain: 'rainierathletes.org' };
  response.cookie('RaToken', raToken, cookieOptions);
  response.cookie('RaUser', Buffer.from(profile.role)
    .toString('base64'), cookieOptions);
  return response.redirect(process.env.CLIENT_URL);
});

export default googleOAuthRouter;
